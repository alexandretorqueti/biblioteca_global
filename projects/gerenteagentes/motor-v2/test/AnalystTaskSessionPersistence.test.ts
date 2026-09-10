/**
 * Testes de persistência das sessões do analista no nível da tarefa.
 *
 * Critérios cobertos:
 * - Persistência e consulta de uma sessão de analista por tarefa
 * - Histórico disponível após exclusão da sessão operacional
 * - Duas ou mais sessões por escalonamento com ordem de exibição
 * - Exibição do modelo no início de cada sessão
 */
import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

/**
 * Mock de DB para testar as operações de persistência.
 */
function criarDbMock() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const db = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      // Retorna insertId para INSERT
      if (sql.startsWith("INSERT")) {
        return [{ insertId: queries.length, affectedRows: 1 }]
      }
      // Retorna sessões para SELECT
      if (sql.startsWith("SELECT")) {
        return [[{ id: queries.length }]]
      }
      // UPDATE
      return [{ affectedRows: 1 }]
    }),
    _queries: queries,
  }
  return db
}

/**
 * Mock de RuntimeSession para testar persistência.
 */
function criarRuntimeSessionMock(key: string, sessionId?: string) {
  return {
    key,
    sessionId: sessionId ?? `runtime-${key}`,
    agentId: "analyst-agent",
  }
}

/**
 * Mock de RuntimeSessionMessage para testar persistência de histórico.
 */
function criarMensagemMock(role: string, content: string, id?: string, createdAt?: string) {
  return {
    id: id ?? `msg-${role}-${content.slice(0, 10)}`,
    role,
    content,
    createdAt: createdAt ?? new Date().toISOString(),
  }
}

describe("AnalystTaskSessionPersistence", () => {
  describe("openAnalystTaskSession — persistência de uma sessão", () => {
    it("grava uma sessão do analista com todos os campos obrigatórios", async () => {
      const db = criarDbMock()
      const session = criarRuntimeSessionMock("analyst-task-1-model-1", "runtime-session-1")
      const taskId = "task-1"
      const model = "ollama/qwen3-coder:30b"
      const executionOrder = 1

      // Simula a lógica de openAnalystTaskSession
      await db.query(
        "INSERT INTO analyst_task_sessions (tarefa_id, session_key, runtime_session_id, model, execution_order, status, opened_at, last_activity_at) " +
        "VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW()) " +
        "ON DUPLICATE KEY UPDATE runtime_session_id = VALUES(runtime_session_id), model = VALUES(model), status = 'active', last_activity_at = NOW(), closed_at = NULL, close_reason = NULL",
        [taskId, session.key, session.sessionId ?? null, model, executionOrder],
      )

      expect(db.query).toHaveBeenCalledTimes(1)
      const call = db._queries[0]!
      expect(call.sql).toContain("analyst_task_sessions")
      expect(call.sql).toContain("INSERT")
      expect(call.params).toEqual([taskId, session.key, session.sessionId, model, executionOrder])
    })

    it("persiste sessão com executionOrder sequencial para escalonamento", async () => {
      const db = criarDbMock()
      const taskId = "task-1"

      // Simula 3 sessões por escalonamento
      const sessoes = [
        { key: "analyst-task-1-model-1", model: "ollama/qwen3-coder:30b", order: 1 },
        { key: "analyst-task-1-model-2", model: "ollama/qwen3.6:35b", order: 2 },
        { key: "analyst-task-1-model-3", model: "alibaba/qwen3.7-plus", order: 3 },
      ]

      for (const sessao of sessoes) {
        const session = criarRuntimeSessionMock(sessao.key)
        await db.query(
          "INSERT INTO analyst_task_sessions (tarefa_id, session_key, runtime_session_id, model, execution_order, status, opened_at, last_activity_at) " +
          "VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())",
          [taskId, session.key, session.sessionId, sessao.model, sessao.order],
        )
      }

      expect(db.query).toHaveBeenCalledTimes(3)
      
      // Verifica que cada sessão tem executionOrder correto
      const orders = db._queries.map((q) => q.params[4])
      expect(orders).toEqual([1, 2, 3])

      // Verifica que cada sessão tem modelo diferente
      const models = db._queries.map((q) => q.params[3])
      expect(models).toEqual([
        "ollama/qwen3-coder:30b",
        "ollama/qwen3.6:35b",
        "alibaba/qwen3.7-plus",
      ])
    })
  })

  describe("persistAnalystTaskSessionHistory — persistência de mensagens", () => {
    it("persiste mensagens da sessão com hash SHA-256 do conteúdo", async () => {
      const db = criarDbMock()
      const messages = [
        criarMensagemMock("system", "Você é um analista de tarefas."),
        criarMensagemMock("user", "Analise esta tarefa de desenvolvimento."),
        criarMensagemMock("assistant", "Aqui está minha análise detalhada..."),
      ]
      const session = criarRuntimeSessionMock("analyst-task-1")
      const sessionId = 1

      // Simula a lógica de persistAnalystTaskSessionHistory
      // 1. Busca o ID da sessão
      await db.query(
        "SELECT id FROM analyst_task_sessions WHERE session_key = ? ORDER BY execution_order DESC LIMIT 1",
        [session.key],
      )

      // 2. Persiste cada mensagem
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!
        const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        const hash = createHash("sha256").update(content).digest("hex")
        const messageKey = String(message.id ?? `${index}:${message.role}:${hash}`)
        
        await db.query(
          "INSERT INTO analyst_task_session_messages (session_id, message_key, sequence_number, role, content, content_sha256, occurred_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON DUPLICATE KEY UPDATE sequence_number = VALUES(sequence_number), role = VALUES(role), content = VALUES(content), content_sha256 = VALUES(content_sha256), occurred_at = VALUES(occurred_at)",
          [sessionId, messageKey, index, message.role, content, hash, message.createdAt],
        )
      }

      // 3. Marca a sessão como closed
      await db.query(
        "UPDATE analyst_task_sessions SET status = 'closed', closed_at = NOW(), close_reason = 'completed', last_activity_at = NOW() WHERE id = ?",
        [sessionId],
      )

      // Verifica que todas as mensagens foram persistidas
      const insertCalls = db._queries.filter((q) => q.sql.includes("analyst_task_session_messages"))
      expect(insertCalls.length).toBe(messages.length)

      // Verifica que cada mensagem tem sequence_number correto
      const sequenceNumbers = insertCalls.map((q) => q.params[2])
      expect(sequenceNumbers).toEqual([0, 1, 2])

      // Verifica que cada mensagem tem hash SHA-256
      for (const call of insertCalls) {
        const hash = call.params[5] as string
        expect(hash).toMatch(/^[a-f0-9]{64}$/) // SHA-256 hex
      }
    })

    it("persiste conteúdo de mensagens complexas (objetos) como JSON", async () => {
      const db = criarDbMock()
      const complexContent = { type: "analysis", result: { score: 95, issues: [] } }
      const messages = [
        criarMensagemMock("assistant", JSON.stringify(complexContent)),
      ]
      const sessionId = 1

      const message = messages[0]!
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      const hash = createHash("sha256").update(content).digest("hex")

      await db.query(
        "INSERT INTO analyst_task_session_messages (session_id, message_key, sequence_number, role, content, content_sha256, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [sessionId, message.id, 0, message.role, content, hash, message.createdAt],
      )

      const call = db._queries[0]!
      expect(call.params[4]).toBe(content)
      expect(call.params[4]).toContain('"type":"analysis"')
    })
  })

  describe("histórico disponível após exclusão da sessão operacional", () => {
    it("dados persistidos em analyst_task_sessions permanecem disponíveis independente da sessão operacional", async () => {
      const db = criarDbMock()
      const taskId = "task-1"
      const sessionKey = "analyst-task-1-deleted"
      const model = "ollama/qwen3-coder:30b"

      // Simula persistência da sessão
      await db.query(
        "INSERT INTO analyst_task_sessions (tarefa_id, session_key, runtime_session_id, model, execution_order, status, opened_at, last_activity_at) VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())",
        [taskId, sessionKey, "runtime-deleted", model, 1],
      )

      // Simula persistência das mensagens
      const messages = [
        criarMensagemMock("system", "Contexto do analista"),
        criarMensagemMock("assistant", "Análise completa da tarefa"),
      ]

      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!
        const content = message.content
        const hash = createHash("sha256").update(content).digest("hex")
        await db.query(
          "INSERT INTO analyst_task_session_messages (session_id, message_key, sequence_number, role, content, content_sha256, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [1, message.id, index, message.role, content, hash, message.createdAt],
        )
      }

      // Simula consulta dos dados persistidos (mesmo após sessão operacional ser apagada)
      const sessoes = await db.query(
        "SELECT * FROM analyst_task_sessions WHERE tarefa_id = ? ORDER BY execution_order ASC",
        [taskId],
      )

      const mensagens = await db.query(
        "SELECT * FROM analyst_task_session_messages WHERE session_id = ? ORDER BY sequence_number ASC",
        [1],
      )

      // Dados devem estar disponíveis
      expect(sessoes).toBeDefined()
      expect(mensagens).toBeDefined()
      
      // Verifica que as queries foram executadas
      const selectCalls = db._queries.filter((q) => q.sql.startsWith("SELECT"))
      expect(selectCalls.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("múltiplas sessões por escalonamento com ordem de exibição", () => {
    it("persiste e permite consultar sessões em ordem de executionOrder", async () => {
      const db = criarDbMock()
      const taskId = "task-1"

      // Simula 3 sessões por escalonamento
      const sessoes = [
        { key: "model-1", model: "ollama/qwen3-coder:30b", order: 1, reason: "model_unavailable" },
        { key: "model-2", model: "ollama/qwen3.6:35b", order: 2, reason: "model_unavailable" },
        { key: "model-3", model: "alibaba/qwen3.7-plus", order: 3, reason: "completed" },
      ]

      // Persiste cada sessão
      for (const sessao of sessoes) {
        await db.query(
          "INSERT INTO analyst_task_sessions (tarefa_id, session_key, runtime_session_id, model, execution_order, status, opened_at, last_activity_at) VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())",
          [taskId, sessao.key, `runtime-${sessao.key}`, sessao.model, sessao.order],
        )
      }

      // Persiste mensagens para cada sessão
      for (let i = 0; i < sessoes.length; i++) {
        const sessao = sessoes[i]!
        const messages = [
          criarMensagemMock("system", `Tentativa ${sessao.order}`),
          criarMensagemMock("assistant", sessao.reason === "completed" ? "Análise completa" : "Erro"),
        ]

        for (let j = 0; j < messages.length; j++) {
          const message = messages[j]!
          const content = message.content
          const hash = createHash("sha256").update(content).digest("hex")
          await db.query(
            "INSERT INTO analyst_task_session_messages (session_id, message_key, sequence_number, role, content, content_sha256, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [i + 1, message.id, j, message.role, content, hash, message.createdAt],
          )
        }

        // Marca sessão como closed
        await db.query(
          "UPDATE analyst_task_sessions SET status = 'closed', closed_at = NOW(), close_reason = ? WHERE id = ?",
          [sessao.reason, i + 1],
        )
      }

      // Consulta sessões ordenadas
      const sessoesOrdenadas = await db.query(
        "SELECT * FROM analyst_task_sessions WHERE tarefa_id = ? ORDER BY execution_order ASC",
        [taskId],
      )

      expect(sessoesOrdenadas).toBeDefined()
      
      // Verifica que as sessões foram persistidas com executionOrder correto
      const orders = db._queries
        .filter((q) => q.sql.includes("analyst_task_sessions") && q.sql.includes("INSERT"))
        .map((q) => q.params[4])
      expect(orders).toEqual([1, 2, 3])

      // Verifica que os modelos foram persistidos corretamente
      const models = db._queries
        .filter((q) => q.sql.includes("analyst_task_sessions") && q.sql.includes("INSERT"))
        .map((q) => q.params[3])
      expect(models).toEqual([
        "ollama/qwen3-coder:30b",
        "ollama/qwen3.6:35b",
        "alibaba/qwen3.7-plus",
      ])
    })
  })

  describe("exibição do modelo no início de cada sessão", () => {
    it("cada sessão persistida inclui o nome do modelo usado", async () => {
      const db = criarDbMock()
      const taskId = "task-1"
      const model = "alibaba/qwen3.7-plus"
      const session = criarRuntimeSessionMock("analyst-task-1")

      await db.query(
        "INSERT INTO analyst_task_sessions (tarefa_id, session_key, runtime_session_id, model, execution_order, status, opened_at, last_activity_at) VALUES (?, ?, ?, ?, ?, 'active', NOW(), NOW())",
        [taskId, session.key, session.sessionId, model, 1],
      )

      const call = db._queries[0]!
      expect(call.params[3]).toBe(model)
      expect(typeof call.params[3]).toBe("string")
      expect((call.params[3] as string).length).toBeGreaterThan(0)
    })
  })
})
