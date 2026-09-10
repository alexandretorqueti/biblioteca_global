import { describe, expect, it, vi } from "vitest"
import {
  formatClarificationMessage,
  formatHistoryForPrompt,
  persistTaskClarification,
  persistTaskClarificationAnswer,
  fetchTaskClarificationHistory,
  fetchLatestTaskClarificationAnswer,
  formatPlanProposalMessage,
  persistTaskPlanProposal,
} from "../src/planning/ClarificationStore.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

function mockDb(responses: QueryResult[]): Db {
  const db: Db = {
    query: vi.fn().mockImplementation(async () => responses.shift() ?? { rows: [], affectedRows: 0, insertId: 0 }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: Db) => Promise<unknown>) => fn(db)),
  }
  return db
}

describe("formatClarificationMessage", () => {
  it("monta mensagem única com entendimento e perguntas numeradas", () => {
    const text = formatClarificationMessage({ summary: "Entendi que é um chat", questions: ["MySQL ou Postgres?", "Qual o prazo?"] })
    expect(text).toContain("Entendimento atual: Entendi que é um chat")
    expect(text).toContain("1) MySQL ou Postgres?")
    expect(text).toContain("2) Qual o prazo?")
  })

  it("omite o entendimento quando o resumo é vazio", () => {
    const text = formatClarificationMessage({ summary: "  ", questions: ["p?"] })
    expect(text).not.toContain("Entendimento atual")
    expect(text).toContain("1) p?")
  })
})

describe("formatHistoryForPrompt", () => {
  it("marca perguntas e respostas para reinjeção no prompt", () => {
    const text = formatHistoryForPrompt([
      { role: "analyst", texto: "1) A ou B?", createdAt: "" },
      { role: "user", texto: "1: A", createdAt: "" },
    ])
    expect(text).toContain("[ANALISTA] 1) A ou B?")
    expect(text).toContain("[RESPOSTA] 1: A")
  })

  it("retorna vazio sem histórico", () => {
    expect(formatHistoryForPrompt([])).toBe("")
  })
})

describe("persistTaskClarification", () => {
  it("resolve a tarefa por external_id e grava mensagem analyst", async () => {
    const db = mockDb([
      { rows: [{ id: 42 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 1 },
    ])
    await persistTaskClarification(db, "task-9", { summary: "s", questions: ["p?"] })
    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[0]![0])).toContain("FROM tarefas")
    const [insertSql, params] = calls[1]!
    expect(String(insertSql)).toContain("INSERT INTO tarefa_chats")
    expect(params).toEqual([42, "analyst", null, expect.stringContaining("1) p?")])
  })
})

describe("persistTaskClarificationAnswer", () => {
  it("grava a resposta como role user na mesma tabela do chat", async () => {
    const db = mockDb([
      { rows: [{ id: 42 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 2 },
    ])
    await persistTaskClarificationAnswer(db, "42", "1: MySQL")
    const [insertSql, params] = vi.mocked(db.query).mock.calls[1]!
    expect(String(insertSql)).toContain("INSERT INTO tarefa_chats")
    expect(params).toEqual([42, "user", null, "1: MySQL"])
  })
})

describe("fetchTaskClarificationHistory", () => {
  it("retorna somente mensagens analyst/user em ordem", async () => {
    const db = mockDb([
      { rows: [{ id: 42 }], affectedRows: 0, insertId: 0 },
      {
        rows: [
          { role: "analyst", texto: "1) A?", created_at: "2026-09-01 12:00:00" },
          { role: "user", texto: "1: B", created_at: "2026-09-01 13:00:00" },
        ],
        affectedRows: 0,
        insertId: 0,
      },
    ])
    const history = await fetchTaskClarificationHistory(db, "task-9")
    expect(history).toHaveLength(2)
    expect(history[0]!.role).toBe("analyst")
    const [selectSql, params] = vi.mocked(db.query).mock.calls[1]!
    expect(String(selectSql)).toContain("role IN (?, ?)")
    expect(params).toEqual([42, "analyst", "user"])
  })
})

describe("fetchLatestTaskClarificationAnswer", () => {
  it("recupera somente o último turno do usuário para encaminhar à sessão", async () => {
    const db = mockDb([
      { rows: [{ id: 42 }], affectedRows: 0, insertId: 0 },
      { rows: [{ texto: "  O que você quer dizer com a pergunta 2?  " }], affectedRows: 0, insertId: 0 },
    ])
    await expect(fetchLatestTaskClarificationAnswer(db, "task-9")).resolves.toBe("O que você quer dizer com a pergunta 2?")
    const [sql, params] = vi.mocked(db.query).mock.calls[1]!
    expect(String(sql)).toContain("ORDER BY id DESC LIMIT 1")
    expect(params).toEqual([42, "user"])
  })
})

describe("fetchAnsweredTaskClarifications", () => {
  it("retorna tarefas aguardando clarificação cuja última mensagem é do usuário", async () => {
    const { fetchAnsweredTaskClarifications } = await import("../src/planning/ClarificationStore.js")
    const db = mockDb([
      {
        rows: [
          { db_id: 749, external_id: "task-plataforma", texto: "1: resposta" },
          { db_id: 750, external_id: null, texto: "pode seguir" },
        ],
        affectedRows: 0,
        insertId: 0,
      },
    ])
    const answered = await fetchAnsweredTaskClarifications(db)
    expect(answered).toHaveLength(2)
    expect(answered[0]).toEqual({ taskId: "task-plataforma", texto: "1: resposta" })
    // Sem external_id: usa o id numérico como referência
    expect(answered[1]).toEqual({ taskId: "750", texto: "pode seguir" })
    const [sql, params] = vi.mocked(db.query).mock.calls[0]!
    expect(String(sql)).toContain("t.status = ?")
    expect(String(sql)).toContain("c.role = ?")
    expect(params).toEqual(["awaiting_clarification", "user", "analyst", "user"])
  })

  it("retorna lista vazia quando nenhuma resposta está pendente", async () => {
    const { fetchAnsweredTaskClarifications } = await import("../src/planning/ClarificationStore.js")
    const db = mockDb([{ rows: [], affectedRows: 0, insertId: 0 }])
    expect(await fetchAnsweredTaskClarifications(db)).toEqual([])
  })
})

describe("formatPlanProposalMessage", () => {
  it("formata proposta de plano com subtarefas e ações disponíveis", () => {
    const message = formatPlanProposalMessage({
      version: 1,
      subtasks: [
        {
          seq: 1,
          titulo: "Configurar banco de dados",
          scope: "Criar migration e validar schema",
          acceptanceCriteria: ["Migration aplicada", "Schema válido"],
          deliverables: ["migration.sql", "teste de schema"],
          requirementsCovered: ["REQ-1"],
          dependsOn: [],
        },
        {
          seq: 2,
          titulo: "Implementar API",
          scope: "Criar endpoints CRUD",
          acceptanceCriteria: ["Endpoints funcionando"],
          deliverables: ["controller.ts", "routes.ts"],
          requirementsCovered: ["REQ-2"],
          dependsOn: [1],
        },
      ],
    })
    expect(message).toContain("Proposta de Plano (versão 1)")
    expect(message).toContain("1. Configurar banco de dados")
    expect(message).toContain("2. Implementar API")
    expect(message).toContain("Escopo: Criar migration e validar schema")
    expect(message).toContain("Entregáveis: migration.sql, teste de schema")
    expect(message).toContain("Depende de: seq 1")
    expect(message).toContain("Aprovar e iniciar")
    expect(message).toContain("Solicitar ajustes")
    expect(message).toContain("Continuar conversando")
  })

  it("omite campos vazios da formatação", () => {
    const message = formatPlanProposalMessage({
      version: 2,
      subtasks: [
        {
          seq: 1,
          titulo: "Tarefa simples",
          scope: "",
          acceptanceCriteria: [],
          deliverables: [],
          requirementsCovered: ["REQ-1"],
          dependsOn: [],
        },
      ],
    })
    expect(message).toContain("Proposta de Plano (versão 2)")
    expect(message).toContain("1. Tarefa simples")
    expect(message).not.toContain("Escopo:")
    expect(message).not.toContain("Entregáveis:")
    expect(message).not.toContain("Depende de:")
  })
})

describe("persistTaskPlanProposal", () => {
  it("persiste proposta de plano no chat da tarefa como mensagem analyst", async () => {
    const db = mockDb([
      { rows: [{ id: 42 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 1 },
    ])
    await persistTaskPlanProposal(db, "task-9", {
      version: 1,
      subtasks: [
        {
          seq: 1,
          titulo: "Teste",
          scope: "Escopo",
          acceptanceCriteria: ["critério"],
          deliverables: ["entregável"],
          requirementsCovered: ["REQ-1"],
          dependsOn: [],
        },
      ],
    })
    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[0]![0])).toContain("FROM tarefas")
    const [insertSql, params] = calls[1]!
    expect(String(insertSql)).toContain("INSERT INTO tarefa_chats")
    expect(params).toEqual([42, "analyst", null, expect.stringContaining("Proposta de Plano")])
    expect(params).toEqual([42, "analyst", null, expect.stringContaining("1. Teste")])
  })
})
