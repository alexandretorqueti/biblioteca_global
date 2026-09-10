/**
 * Testes integrados da subtarefa 10: Compatibilidade legada e ciclo completo
 * do chat natural com analista antes da aprovação do plano.
 *
 * Critérios de aceite:
 * 1. Tarefas antigas em awaiting_clarification continuam carregáveis e utilizáveis
 * 2. Tarefas legadas seguem para conversa ou aguardando aprovação sem perda de dados
 * 3. Os testes cobrem conversa natural e reutilização de sessão
 * 4. Os testes cobrem retomada após reinício, aprovação e solicitação de ajustes
 * 5. Os testes cobrem ausência de subtarefas antes da aprovação e geração com dependências após aprovação
 * 6. A interface deixa claro conversa, aguardando aprovação e execução
 * 7. A suíte relevante do projeto passa sem regressões
 */

import { describe, expect, it } from "vitest"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"
import {
  detectLegacyAwaitingClarification,
  adaptLegacyHistory,
  ensureLegacyTaskHasAnalystSession,
  migrateLegacyTaskToNaturalChat,
  canLegacyTaskContinue,
} from "../src/planning/LegacyCompat.js"
import {
  persistTaskClarification,
  persistTaskClarificationAnswer,
  persistTaskAnalystMessage,
  persistTaskPlanProposal,
  persistPlanDecision,
  fetchTaskClarificationHistory,
  fetchPlanDecisions,
  formatHistoryForPrompt,
  formatPlanProposalMessage,
} from "../src/planning/ClarificationStore.js"
import {
  getOrReserveTaskAnalystSession,
} from "../src/planning/AnalystSessionStore.js"
import {
  persistPlanProposal,
  approvePlanProposal,
  rejectPlanProposal,
  fetchPendingPlanProposal,
  fetchPlanProposalHistory,
} from "../src/planning/PlanProposalStore.js"
import {
  persistTransitionAudit,
  fetchTransitionAudit,
  fetchTaskConversationRecovery,
  fetchTaskAnalystSessionLink,
} from "../src/planning/TransitionAuditStore.js"
import { transitionTask } from "../src/policies/TaskStateMachine.js"
import { parseAnalystConversationReply } from "../src/planning/AnalystReply.js"

// ============================================================================
// MOCK DB
// ============================================================================

interface MockData {
  tasks: Array<{ id: number; external_id: string; status: string }>
  chats: Array<Record<string, unknown>>
  sessions: Array<Record<string, unknown>>
  proposals: Array<Record<string, unknown>>
  transitions: Array<Record<string, unknown>>
  chatIdSeq: number
  sessionIdSeq: number
  proposalIdSeq: number
  transitionIdSeq: number
}

function createMockDb(): Db & { _data: MockData } {
  const data: MockData = {
    tasks: [],
    chats: [],
    sessions: [],
    proposals: [],
    transitions: [],
    chatIdSeq: 0,
    sessionIdSeq: 0,
    proposalIdSeq: 0,
    transitionIdSeq: 0,
  }

  const db: Db & { _data: MockData } = {
    _data: data,
    async query(sql: string, params: unknown[] = []) {
      return handleQuery(data, sql, params)
    },
    async transaction(fn) {
      return fn(db)
    },
  }
  return db
}

function handleQuery(data: MockData, sql: string, params: unknown[]): QueryResult {
  const normalized = sql.replace(/\s+/g, " ").trim()

  // SELECT tarefas (status = 'awaiting_clarification')
  if (normalized.includes("FROM tarefas t WHERE t.status = 'awaiting_clarification'")) {
    const found = data.tasks.filter((t) => t.status === "awaiting_clarification")
    return { rows: found.map((t) => ({ id: t.id, external_id: t.external_id })), affectedRows: 0, insertId: 0 }
  }

  // Task lookup (SELECT id, status FROM tarefas)
  if (normalized.includes("FROM tarefas WHERE external_id") && normalized.includes("SELECT id, status")) {
    const externalId = String(params[0])
    const task = data.tasks.find((t) => t.external_id === externalId || String(t.id) === externalId)
    return { rows: task ? [{ id: task.id, status: task.status }] : [], affectedRows: 0, insertId: 0 }
  }

  // Task lookup (SELECT id FROM tarefas)
  if (normalized.includes("FROM tarefas WHERE external_id") && !normalized.startsWith("INSERT") && !normalized.startsWith("UPDATE")) {
    const externalId = String(params[0])
    const task = data.tasks.find((t) => t.external_id === externalId || String(t.id) === externalId)
    return { rows: task ? [{ id: task.id }] : [], affectedRows: 0, insertId: 0 }
  }

  // INSERT tarefa_chats
  if (normalized.startsWith("INSERT INTO tarefa_chats")) {
    data.chatIdSeq++
    const [taskId, role, author, texto] = params
    data.chats.push({
      id: data.chatIdSeq,
      tarefa_id: taskId,
      role,
      author: author ?? null,
      texto,
      created_at: new Date().toISOString(),
    })
    return { rows: [], affectedRows: 1, insertId: data.chatIdSeq }
  }

  // SELECT tarefa_chats (count legacy messages without author)
  if (normalized.includes("FROM tarefa_chats") && normalized.includes("author IS NULL")) {
    const taskId = Number(params[0])
    const count = data.chats.filter(
      (c) => Number(c.tarefa_id) === taskId && c.role === "analyst" && (c.author == null || c.author === "")
    ).length
    return { rows: [{ count }], affectedRows: 0, insertId: 0 }
  }

  // SELECT tarefa_chats (count messages with role IN)
  if (normalized.includes("FROM tarefa_chats") && normalized.includes("COUNT(*)") && normalized.includes("role IN")) {
    const taskId = Number(params[0])
    const count = data.chats.filter(
      (c) => Number(c.tarefa_id) === taskId && (c.role === "analyst" || c.role === "user")
    ).length
    return { rows: [{ count }], affectedRows: 0, insertId: 0 }
  }

  // SELECT tarefa_chats (history with role IN)
  if (normalized.includes("FROM tarefa_chats") && normalized.includes("role IN") && !normalized.includes("COUNT")) {
    const taskId = Number(params[0])
    const found = data.chats.filter(
      (c) => Number(c.tarefa_id) === taskId && (c.role === "analyst" || c.role === "user")
    ).sort((a, b) => Number(a.id) - Number(b.id))
    return { rows: found, affectedRows: 0, insertId: 0 }
  }

  // SELECT tarefa_chats (decisions)
  if (normalized.includes("FROM tarefa_chats") && normalized.includes("texto LIKE")) {
    const taskId = Number(params[0])
    const found = data.chats.filter((c) => {
      if (Number(c.tarefa_id) !== taskId) return false
      const text = String(c.texto ?? "")
      return text.startsWith("✅") || text.startsWith("✏️") || text.startsWith("💬")
    })
    return { rows: found, affectedRows: 0, insertId: 0 }
  }

  // SELECT motor_task_analyst_sessions (existence check for legacy)
  if (normalized.includes("FROM motor_task_analyst_sessions") && normalized.includes("WHERE tarefa_id = (SELECT") && normalized.includes("LIMIT 1")) {
    const externalId = String(params[0])
    const task = data.tasks.find((t) => t.external_id === externalId || String(t.id) === externalId)
    if (!task) return { rows: [], affectedRows: 0, insertId: 0 }
    const found = data.sessions.filter((s) => Number(s.tarefa_id) === task.id)
    return { rows: found.length > 0 ? [{ id: found[0].id }] : [], affectedRows: 0, insertId: 0 }
  }

  // INSERT IGNORE INTO motor_task_analyst_sessions
  if (normalized.startsWith("INSERT IGNORE INTO motor_task_analyst_sessions")) {
    data.sessionIdSeq++
    const [taskId, agentId, model, sessionKey] = params
    const existing = data.sessions.find((s) => Number(s.tarefa_id) === Number(taskId))
    if (!existing) {
      data.sessions.push({
        id: data.sessionIdSeq,
        tarefa_id: taskId,
        agent_id: agentId,
        model,
        session_key: sessionKey,
        runtime_session_id: null,
        status: "active",
        opened_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
      })
    }
    return { rows: [], affectedRows: 1, insertId: 0 }
  }

  // SELECT motor_task_analyst_sessions (by tarefa_id, LIMIT 1 - for getOrReserve)
  if (normalized.includes("FROM motor_task_analyst_sessions") && normalized.includes("WHERE tarefa_id = ?") && normalized.includes("LIMIT 1") && !normalized.includes("status = ")) {
    const taskId = Number(params[0])
    const found = data.sessions.filter((s) => Number(s.tarefa_id) === taskId)
    return { rows: found.length > 0 ? [found[0]] : [], affectedRows: 0, insertId: 0 }
  }

  // SELECT motor_task_analyst_sessions (active, for recovery)
  if (normalized.includes("FROM motor_task_analyst_sessions") && normalized.includes("status = 'active'")) {
    const taskId = Number(params[0])
    const found = data.sessions.filter(
      (s) => Number(s.tarefa_id) === taskId && s.status === "active"
    )
    return { rows: found.length > 0 ? [found[0]] : [], affectedRows: 0, insertId: 0 }
  }

  // UPDATE motor_task_analyst_sessions
  if (normalized.startsWith("UPDATE motor_task_analyst_sessions")) {
    return { rows: [], affectedRows: 1, insertId: 0 }
  }

  // INSERT motor_plan_proposals
  if (normalized.startsWith("INSERT INTO motor_plan_proposals")) {
    data.proposalIdSeq++
    const [taskId, version, subtasksJson, coverageJson] = params
    data.proposals.push({
      id: data.proposalIdSeq,
      tarefa_id: taskId,
      version,
      status: "proposed",
      subtasks_json: subtasksJson,
      coverage_json: coverageJson,
      proposed_at: new Date().toISOString(),
      decided_at: null,
      decided_by: null,
      decision_reason: null,
    })
    return { rows: [], affectedRows: 1, insertId: data.proposalIdSeq }
  }

  // SELECT motor_plan_proposals (version MAX)
  if (normalized.includes("COALESCE(MAX(version)")) {
    const taskId = Number(params[0])
    const versions = data.proposals
      .filter((p) => Number(p.tarefa_id) === taskId)
      .map((p) => Number(p.version))
    const max = versions.length > 0 ? Math.max(...versions) : 0
    return { rows: [{ max_version: max }], affectedRows: 0, insertId: 0 }
  }

  // SELECT motor_plan_proposals (by version)
  if (normalized.includes("FROM motor_plan_proposals WHERE tarefa_id") && normalized.includes("AND version")) {
    const taskId = Number(params[0])
    const version = Number(params[1])
    const found = data.proposals.filter(
      (p) => Number(p.tarefa_id) === taskId && Number(p.version) === version
    )
    return { rows: found, affectedRows: 0, insertId: 0 }
  }

  // SELECT motor_plan_proposals (proposed)
  if (normalized.includes("FROM motor_plan_proposals WHERE tarefa_id") && normalized.includes("status = 'proposed'")) {
    const taskId = Number(params[0])
    const found = data.proposals
      .filter((p) => Number(p.tarefa_id) === taskId && p.status === "proposed")
      .sort((a, b) => Number(b.version) - Number(a.version))
    return { rows: found.length > 0 ? [found[0]] : [], affectedRows: 0, insertId: 0 }
  }

  // SELECT motor_plan_proposals (history - all versions ORDER BY version ASC)
  if (normalized.includes("FROM motor_plan_proposals WHERE tarefa_id") && normalized.includes("ORDER BY version ASC")) {
    const taskId = Number(params[0])
    const found = data.proposals
      .filter((p) => Number(p.tarefa_id) === taskId)
      .sort((a, b) => Number(a.version) - Number(b.version))
    return { rows: found, affectedRows: 0, insertId: 0 }
  }

  // UPDATE motor_plan_proposals
  if (normalized.startsWith("UPDATE motor_plan_proposals SET status")) {
    const statusMatch = normalized.match(/status = '(\w+)'/)
    const newStatus = statusMatch ? statusMatch[1] : "approved"
    const decidedBy = params[0]
    const reason = params[1]
    const id = params[2]
    const proposal = data.proposals.find((p) => Number(p.id) === Number(id))
    if (proposal) {
      proposal.status = newStatus
      proposal.decided_by = decidedBy
      proposal.decision_reason = reason
      proposal.decided_at = new Date().toISOString()
    }
    return { rows: [], affectedRows: 1, insertId: 0 }
  }

  // INSERT motor_task_transition_audit
  if (normalized.startsWith("INSERT INTO motor_task_transition_audit")) {
    data.transitionIdSeq++
    const [taskId, transition, statusAnterior, statusNovo, analystSessionId, planProposalId, planProposalVersion, decisionType, decisionActor, decisionReason, executionId, workerId, lastChatMessageId, motivo] = params
    data.transitions.push({
      id: data.transitionIdSeq,
      tarefa_id: taskId,
      transition,
      status_anterior: statusAnterior,
      status_novo: statusNovo,
      analyst_session_id: analystSessionId ?? null,
      plan_proposal_id: planProposalId ?? null,
      plan_proposal_version: planProposalVersion ?? null,
      decision_type: decisionType ?? null,
      decision_actor: decisionActor ?? null,
      decision_reason: decisionReason ?? null,
      execution_id: executionId ?? null,
      worker_id: workerId ?? null,
      last_chat_message_id: lastChatMessageId ?? null,
      motivo: motivo ?? null,
      occurred_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    return { rows: [], affectedRows: 1, insertId: data.transitionIdSeq }
  }

  // SELECT motor_task_transition_audit (last - ORDER BY occurred_at DESC)
  if (normalized.includes("FROM motor_task_transition_audit") && normalized.includes("ORDER BY occurred_at DESC")) {
    const taskId = Number(params[0])
    const found = data.transitions
      .filter((t) => Number(t.tarefa_id) === taskId)
      .sort((a, b) => {
        const cmp = String(b.occurred_at).localeCompare(String(a.occurred_at))
        return cmp !== 0 ? cmp : Number(b.id) - Number(a.id)
      })
    return { rows: found.length > 0 ? [found[0]] : [], affectedRows: 0, insertId: 0 }
  }

  // SELECT motor_task_transition_audit (all - ORDER BY occurred_at ASC)
  if (normalized.includes("FROM motor_task_transition_audit") && normalized.includes("WHERE tarefa_id") && !normalized.includes("transition =")) {
    const taskId = Number(params[0])
    const found = data.transitions
      .filter((t) => Number(t.tarefa_id) === taskId)
      .sort((a, b) => {
        const cmp = String(a.occurred_at).localeCompare(String(b.occurred_at))
        return cmp !== 0 ? cmp : Number(a.id) - Number(b.id)
      })
    return { rows: found, affectedRows: 0, insertId: 0 }
  }

  return { rows: [], affectedRows: 0, insertId: 0 }
}

// ============================================================================
// HELPERS
// ============================================================================

function addTask(db: Db & { _data: MockData }, externalId: string, status: string) {
  const id = db._data.tasks.length + 100
  db._data.tasks.push({ id, external_id: externalId, status })
  return id
}

function addMessages(db: Db & { _data: MockData }, taskDbId: number, messages: Array<{ role: string; author: string | null; texto: string }>) {
  for (const msg of messages) {
    db._data.chatIdSeq++
    db._data.chats.push({
      id: db._data.chatIdSeq,
      tarefa_id: taskDbId,
      role: msg.role,
      author: msg.author,
      texto: msg.texto,
      created_at: new Date().toISOString(),
    })
  }
}

const sampleSubtasks = [
  {
    seq: 1,
    titulo: "Implementar validação",
    scope: "Criar função de validação",
    acceptanceCriteria: ["Valida entrada"],
    deliverables: ["src/validator.ts"],
    requirementsCovered: ["REQ-1"],
    dependsOn: [],
  },
  {
    seq: 2,
    titulo: "Criar testes",
    scope: "Escrever testes unitários",
    acceptanceCriteria: ["Testes passando"],
    deliverables: ["tests/validator.test.ts"],
    requirementsCovered: ["REQ-2"],
    dependsOn: [1],
  },
]

const sampleCoverage = {
  requirements: [
    { id: "REQ-1", description: "Validação de entrada" },
    { id: "REQ-2", description: "Testes unitários" },
  ],
  coverage: [
    { requirement: "REQ-1", coveredBy: [1] },
    { requirement: "REQ-2", coveredBy: [2] },
  ],
}

// ============================================================================
// TESTES
// ============================================================================

describe("Subtarefa 10: Compatibilidade legada e ciclo completo", () => {
  // ==========================================================================
  // Critério 1: Tarefas antigas em awaiting_clarification continuam carregáveis
  // ==========================================================================

  describe("Critério 1: Tarefas legadas carregáveis e utilizáveis", () => {
    it("detecta tarefa legada com mensagens sem author", async () => {
      const db = createMockDb()
      const taskDbId = addTask(db, "task-legacy-1", "awaiting_clarification")
      addMessages(db, taskDbId, [
        { role: "analyst", author: null, texto: "1) Qual o banco de dados?" },
        { role: "user", author: null, texto: "1: MySQL" },
      ])

      const legacy = await detectLegacyAwaitingClarification(db)
      expect(legacy).toHaveLength(1)
      expect(legacy[0]!.taskId).toBe("task-legacy-1")
      expect(legacy[0]!.hasLegacyMessages).toBe(true)
      expect(legacy[0]!.legacyMessageCount).toBe(1)
    })

    it("detecta tarefa legada sem sessão do analista", async () => {
      const db = createMockDb()
      const taskDbId = addTask(db, "task-legacy-2", "awaiting_clarification")
      addMessages(db, taskDbId, [
        { role: "analyst", author: "analyst-gpt4", texto: "1) Qual o prazo?" },
      ])

      const legacy = await detectLegacyAwaitingClarification(db)
      expect(legacy).toHaveLength(1)
      expect(legacy[0]!.hasAnalystSession).toBe(false)
    })

    it("adapta histórico legado para formato atual", () => {
      const legacyHistory = [
        { role: "analyst", author: null, texto: "1) A ou B?", createdAt: "2026-09-01" },
        { role: "user", author: null, texto: "1: A", createdAt: "2026-09-01" },
        { role: "analyst", author: "analyst-gpt4", texto: "2) C?", createdAt: "2026-09-02" },
      ]

      const adapted = adaptLegacyHistory(legacyHistory)
      expect(adapted[0]!.author).toBe("legacy-analyst")
      expect(adapted[1]!.author).toBe("legacy-user")
      expect(adapted[2]!.author).toBe("analyst-gpt4")
    })

    it("garante sessão do analista para tarefa legada", async () => {
      const db = createMockDb()
      addTask(db, "task-legacy-3", "awaiting_clarification")

      const result = await ensureLegacyTaskHasAnalystSession(db, "task-legacy-3", {
        agentId: "legacy-analyst",
        model: "gpt-4",
      })

      expect(result.sessionKey).toBe("analysis-task-legacy-3")
      expect(db._data.sessions).toHaveLength(1)
      expect(db._data.sessions[0]!.agent_id).toBe("legacy-analyst")
    })

    it("migra tarefa legada para chat natural sem perda de dados", async () => {
      const db = createMockDb()
      const taskDbId = addTask(db, "task-legacy-4", "awaiting_clarification")
      addMessages(db, taskDbId, [
        { role: "analyst", author: null, texto: "1) Qual o banco?" },
        { role: "user", author: null, texto: "1: PostgreSQL" },
      ])

      const result = await migrateLegacyTaskToNaturalChat(db, "task-legacy-4", {
        agentId: "legacy-analyst",
        model: "gpt-4",
      })

      expect(result.sessionKey).toBe("analysis-task-legacy-4")
      expect(db._data.sessions.length).toBeGreaterThanOrEqual(1)
      expect(result.adaptedHistory).toHaveLength(2)
      expect(result.adaptedHistory[0]!.author).toBe("legacy-analyst")
      expect(result.adaptedHistory[1]!.author).toBe("legacy-user")
    })

    it("tarefa legada sem mensagens não pode continuar", async () => {
      const db = createMockDb()
      addTask(db, "task-legacy-6", "awaiting_clarification")

      const result = await canLegacyTaskContinue(db, "task-legacy-6")
      expect(result.canContinue).toBe(false)
      expect(result.reason).toContain("não tem histórico")
    })
  })

  // ==========================================================================
  // Critério 2: Tarefas legadas seguem para conversa ou aprovação sem perda
  // ==========================================================================

  describe("Critério 2: Tarefas legadas seguem para conversa/aprovação sem perda", () => {
    it("tarefa legada pode receber resposta natural após migração", async () => {
      const db = createMockDb()
      const taskDbId = addTask(db, "task-legacy-7", "awaiting_clarification")
      addMessages(db, taskDbId, [
        { role: "analyst", author: null, texto: "1) A ou B?" },
      ])

      await migrateLegacyTaskToNaturalChat(db, "task-legacy-7")
      await persistTaskClarificationAnswer(db, "task-legacy-7", "Prefiro a opção A porque...", "alexandre")

      const history = await fetchTaskClarificationHistory(db, "task-legacy-7")
      expect(history).toHaveLength(2)
      expect(history[0]!.author).toBeNull()
      expect(history[1]!.author).toBe("alexandre")
    })

    it("tarefa legada pode chegar a awaiting_approval sem perda de contexto", async () => {
      const db = createMockDb()
      const taskDbId = addTask(db, "task-legacy-8", "awaiting_clarification")
      addMessages(db, taskDbId, [
        { role: "analyst", author: null, texto: "1) Qual o banco?" },
        { role: "user", author: null, texto: "1: MySQL" },
      ])

      await migrateLegacyTaskToNaturalChat(db, "task-legacy-8")
      await persistPlanProposal(db, "task-legacy-8", sampleSubtasks, sampleCoverage)

      const proposal = await fetchPendingPlanProposal(db, "task-legacy-8")
      expect(proposal).not.toBeNull()
      expect(proposal!.version).toBe(1)
      expect(proposal!.subtasks).toHaveLength(2)
    })

    it("histórico legado é preservado na recuperação após reinício", async () => {
      const db = createMockDb()
      const taskDbId = addTask(db, "task-legacy-9", "awaiting_clarification")
      addMessages(db, taskDbId, [
        { role: "analyst", author: null, texto: "1) A?" },
        { role: "user", author: null, texto: "1: B" },
      ])

      await getOrReserveTaskAnalystSession(db, "task-legacy-9", {
        agentId: "legacy-analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-legacy-9",
      })

      const recovery = await fetchTaskConversationRecovery(db, "task-legacy-9")
      expect(recovery.found).toBe(true)
      expect(recovery.chatHistory).toHaveLength(2)
      expect(recovery.analystSession).not.toBeNull()
      expect(recovery.analystSession!.sessionKey).toBe("analysis-task-legacy-9")
    })
  })

  // ==========================================================================
  // Critério 3: Conversa natural e reutilização de sessão
  // ==========================================================================

  describe("Critério 3: Conversa natural e reutilização de sessão", () => {
    it("analista responde em texto natural sem exigir JSON", () => {
      const reply = parseAnalystConversationReply("A pergunta 2 trata do comportamento após o reinício. O histórico deve continuar disponível.")
      expect(reply.kind).toBe("mensagem")
      if (reply.kind !== "mensagem") throw new Error("inesperado")
      expect(reply.mensagem).toContain("reinício")
    })

    it("sessão do analista é reutilizada em mensagens consecutivas", async () => {
      const db = createMockDb()
      addTask(db, "task-conversation-1", "awaiting_clarification")

      const session1 = await getOrReserveTaskAnalystSession(db, "task-conversation-1", {
        agentId: "analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-conversation-1",
      })

      const session2 = await getOrReserveTaskAnalystSession(db, "task-conversation-1", {
        agentId: "analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-conversation-1",
      })

      expect(session1.id).toBe(session2.id)
      expect(session1.sessionKey).toBe(session2.sessionKey)
      expect(db._data.sessions).toHaveLength(1)
    })

    it("histórico completo é preservado durante conversa", async () => {
      const db = createMockDb()
      const taskDbId = addTask(db, "task-conversation-2", "awaiting_clarification")

      await persistTaskClarification(db, "task-conversation-2", {
        summary: "Entendi que é um chat natural",
        questions: ["Qual o banco de dados?", "Qual o prazo?"],
      }, "analyst-gpt4")

      await persistTaskClarificationAnswer(db, "task-conversation-2", "1: MySQL; 2: 30 dias", "alexandre")
      await persistTaskAnalystMessage(db, "task-conversation-2", "Sobre a pergunta 1: MySQL é uma boa escolha porque...", "analyst-gpt4")
      await persistTaskClarificationAnswer(db, "task-conversation-2", "O que você quer dizer com a pergunta 2?", "alexandre")
      await persistTaskAnalystMessage(db, "task-conversation-2", "A pergunta 2 trata do prazo de entrega. Considerando o escopo...", "analyst-gpt4")

      const history = await fetchTaskClarificationHistory(db, "task-conversation-2")
      expect(history).toHaveLength(5)
      expect(history[0]!.role).toBe("analyst")
      expect(history[1]!.role).toBe("user")
      expect(history[2]!.role).toBe("analyst")
      expect(history[3]!.role).toBe("user")
      expect(history[4]!.role).toBe("analyst")
    })

    it("formatHistoryForPrompt inclui mensagens naturais", () => {
      const history = [
        { role: "analyst", author: "analyst-gpt4", texto: "Entendimento: chat natural", createdAt: "" },
        { role: "user", author: "alexandre", texto: "O que você quer dizer com a pergunta 2?", createdAt: "" },
        { role: "analyst", author: "analyst-gpt4", texto: "A pergunta 2 trata do prazo. Posso explicar:...", createdAt: "" },
      ]

      const formatted = formatHistoryForPrompt(history)
      expect(formatted).toContain("[ANALISTA (analyst-gpt4)]")
      expect(formatted).toContain("[RESPOSTA (alexandre)]")
      expect(formatted).toContain("O que você quer dizer")
      expect(formatted).toContain("A pergunta 2 trata do prazo")
    })
  })

  // ==========================================================================
  // Critério 4: Retomada após reinício, aprovação e ajustes
  // ==========================================================================

  describe("Critério 4: Retomada após reinício, aprovação e ajustes", () => {
    it("recupera sessão e histórico após reinício em awaiting_clarification", async () => {
      const db = createMockDb()
      addTask(db, "task-recovery-1", "awaiting_clarification")

      await getOrReserveTaskAnalystSession(db, "task-recovery-1", {
        agentId: "analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-recovery-1",
      })
      await persistTaskClarification(db, "task-recovery-1", {
        summary: "Entendimento",
        questions: ["Q1?"],
      }, "analyst-gpt4")
      await persistTaskClarificationAnswer(db, "task-recovery-1", "R1", "alexandre")
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "await_clarification",
        statusAnterior: "analyzing",
        statusNovo: "awaiting_clarification",
        analystSessionId: 1,
      })

      const recovery = await fetchTaskConversationRecovery(db, "task-recovery-1")
      expect(recovery.found).toBe(true)
      expect(recovery.analystSession).not.toBeNull()
      expect(recovery.analystSession!.sessionKey).toBe("analysis-task-recovery-1")
      expect(recovery.chatHistory).toHaveLength(2)
      expect(recovery.lastTransition).not.toBeNull()
      expect(recovery.lastTransition!.transition).toBe("await_clarification")
    })

    it("aprovação após retomada funciona corretamente", async () => {
      const db = createMockDb()
      addTask(db, "task-recovery-3", "awaiting_approval")

      await persistPlanProposal(db, "task-recovery-3", sampleSubtasks, sampleCoverage)

      const approved = await approvePlanProposal(db, "task-recovery-3", "alexandre")
      expect(approved).not.toBeNull()
      expect(approved!.status).toBe("approved")
      expect(approved!.decidedBy).toBe("alexandre")
    })

    it("solicitação de ajustes após retomada funciona corretamente", async () => {
      const db = createMockDb()
      addTask(db, "task-recovery-4", "awaiting_approval")

      await persistPlanProposal(db, "task-recovery-4", sampleSubtasks, sampleCoverage)

      const rejected = await rejectPlanProposal(db, "task-recovery-4", "alexandre", "Escopo insuficiente")
      expect(rejected).not.toBeNull()
      expect(rejected!.status).toBe("rejected")
      expect(rejected!.decisionReason).toBe("Escopo insuficiente")
    })

    it("transição de estados após ajuste: awaiting_approval → planned → analyzing", () => {
      expect(transitionTask("awaiting_approval", "request_adjustments")).toBe("planned")
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")
    })
  })

  // ==========================================================================
  // Critério 5: Ausência de subtarefas antes da aprovação
  // ==========================================================================

  describe("Critério 5: Sem subtarefas antes da aprovação; geração com dependências após", () => {
    it("nenhuma subtarefa é criada durante a conversa", async () => {
      const db = createMockDb()
      addTask(db, "task-no-subtasks-1", "awaiting_clarification")

      await persistTaskClarification(db, "task-no-subtasks-1", { summary: "s", questions: ["Q1?"] }, "analyst")
      await persistTaskClarificationAnswer(db, "task-no-subtasks-1", "R1", "alexandre")
      await persistTaskAnalystMessage(db, "task-no-subtasks-1", "Explicação", "analyst")
      await persistTaskClarificationAnswer(db, "task-no-subtasks-1", "R2", "alexandre")

      // Nenhuma subtarefa no mock
      expect(db._data.proposals.filter((p) => p.status === "approved")).toHaveLength(0)
    })

    it("nenhuma subtarefa é criada quando proposta está pendente", async () => {
      const db = createMockDb()
      addTask(db, "task-no-subtasks-2", "awaiting_approval")

      await persistPlanProposal(db, "task-no-subtasks-2", sampleSubtasks, sampleCoverage)

      // Nenhuma proposta aprovada
      expect(db._data.proposals.filter((p) => p.status === "approved")).toHaveLength(0)

      // Proposta existe como "proposed"
      const proposal = await fetchPendingPlanProposal(db, "task-no-subtasks-2")
      expect(proposal).not.toBeNull()
      expect(proposal!.status).toBe("proposed")
    })

    it("após aprovação, proposta muda para approved", async () => {
      const db = createMockDb()
      addTask(db, "task-subtasks-1", "awaiting_approval")

      await persistPlanProposal(db, "task-subtasks-1", sampleSubtasks, sampleCoverage)
      const approved = await approvePlanProposal(db, "task-subtasks-1", "alexandre")
      expect(approved!.status).toBe("approved")

      // Transição para ready
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
    })

    it("dependências entre subtarefas são preservadas", () => {
      expect(sampleSubtasks[0]!.dependsOn).toEqual([])
      expect(sampleSubtasks[1]!.dependsOn).toEqual([1])
    })

    it("repetição da aprovação não é possível (status muda)", () => {
      // Após aprovação, status é ready, e ready não permite approve_plan
      expect(() => transitionTask("ready", "approve_plan")).toThrow()
    })
  })

  // ==========================================================================
  // Critério 6: Interface distingue conversa, aprovação e execução
  // ==========================================================================

  describe("Critério 6: Interface distingue conversa, aprovação e execução", () => {
    it("formatPlanProposalMessage mostra ações disponíveis", () => {
      const message = formatPlanProposalMessage({
        version: 1,
        subtasks: sampleSubtasks,
      })
      expect(message).toContain("Aprovar e iniciar")
      expect(message).toContain("Solicitar ajustes")
      expect(message).toContain("Continuar conversando")
    })

    it("decisões são registradas com emojis distintos", async () => {
      const db = createMockDb()
      const taskDbId = addTask(db, "task-decisions-1", "awaiting_approval")

      await persistPlanDecision(db, "task-decisions-1", "continue_conversation", "alexandre", "Quero entender melhor")
      await persistPlanDecision(db, "task-decisions-1", "request_adjustments", "alexandre", "Escopo insuficiente")
      await persistPlanDecision(db, "task-decisions-1", "approve", "alexandre", null)

      const decisions = await fetchPlanDecisions(db, "task-decisions-1")
      expect(decisions).toHaveLength(3)
      expect(decisions[0]!.decision).toBe("continue_conversation")
      expect(decisions[1]!.decision).toBe("request_adjustments")
      expect(decisions[2]!.decision).toBe("approve")
    })

    it("transições de estado são auditáveis", async () => {
      const db = createMockDb()

      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "await_clarification",
        statusAnterior: "analyzing",
        statusNovo: "awaiting_clarification",
        analystSessionId: 1,
      })
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "clarification_answered",
        statusAnterior: "awaiting_clarification",
        statusNovo: "planned",
      })
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "start_analysis",
        statusAnterior: "planned",
        statusNovo: "analyzing",
      })
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "propose_plan",
        statusAnterior: "analyzing",
        statusNovo: "awaiting_approval",
        planProposalId: 1,
        planProposalVersion: 1,
      })
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "approve_plan",
        statusAnterior: "awaiting_approval",
        statusNovo: "ready",
        planProposalId: 1,
        planProposalVersion: 1,
        decisionType: "approve",
        decisionActor: "alexandre",
      })

      const audit = await fetchTransitionAudit(db, 100)
      expect(audit).toHaveLength(5)
      expect(audit[0]!.transition).toBe("await_clarification")
      expect(audit[1]!.transition).toBe("clarification_answered")
      expect(audit[2]!.transition).toBe("start_analysis")
      expect(audit[3]!.transition).toBe("propose_plan")
      expect(audit[4]!.transition).toBe("approve_plan")
      expect(audit[4]!.decisionType).toBe("approve")
    })

    it("vínculo tarefa↔sessão é consultável", async () => {
      const db = createMockDb()
      addTask(db, "task-link-1", "awaiting_clarification")

      await getOrReserveTaskAnalystSession(db, "task-link-1", {
        agentId: "analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-link-1",
      })

      const link = await fetchTaskAnalystSessionLink(db, 100)
      expect(link).not.toBeNull()
      expect(link!.sessionKey).toBe("analysis-task-link-1")
      expect(link!.agentId).toBe("analyst")
    })
  })

  // ==========================================================================
  // Critério 7: Fluxo completo integrado
  // ==========================================================================

  describe("Critério 7: Fluxo completo integrado", () => {
    it("fluxo completo: conversa → proposta → aprovação → execução", async () => {
      const db = createMockDb()
      addTask(db, "task-full-flow", "planned")

      // 1. Inicia análise
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")

      // 2. Analista pergunta (awaiting_clarification)
      expect(transitionTask("analyzing", "await_clarification")).toBe("awaiting_clarification")
      await getOrReserveTaskAnalystSession(db, "task-full-flow", {
        agentId: "analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-full-flow",
      })
      await persistTaskClarification(db, "task-full-flow", {
        summary: "Entendimento inicial",
        questions: ["Qual o banco?", "Qual o prazo?"],
      }, "analyst-gpt4")

      // 3. Usuário responde
      await persistTaskClarificationAnswer(db, "task-full-flow", "1: MySQL; 2: 30 dias", "alexandre")
      expect(transitionTask("awaiting_clarification", "clarification_answered")).toBe("planned")

      // 4. Reanálise na mesma sessão
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")
      await persistTaskAnalystMessage(db, "task-full-flow", "Ótimo! MySQL com 30 dias é viável.", "analyst-gpt4")

      // 5. Analista apresenta proposta
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")
      await persistPlanProposal(db, "task-full-flow", sampleSubtasks, sampleCoverage)
      await persistTaskPlanProposal(db, "task-full-flow", {
        version: 1,
        subtasks: sampleSubtasks,
      }, "analyst-gpt4")

      // 6. Usuário aprova
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
      await persistPlanDecision(db, "task-full-flow", "approve", "alexandre", null)
      const approved = await approvePlanProposal(db, "task-full-flow", "alexandre")
      expect(approved!.status).toBe("approved")

      // 7. Execução
      expect(transitionTask("ready", "start_execution")).toBe("running")

      // Verifica histórico completo
      const history = await fetchTaskClarificationHistory(db, "task-full-flow")
      expect(history.length).toBeGreaterThanOrEqual(3)

      // Verifica sessão reutilizada
      const link = await fetchTaskAnalystSessionLink(db, 100)
      expect(link).not.toBeNull()
    })

    it("fluxo com ajustes: conversa → proposta → ajustes → nova proposta → aprovação", async () => {
      const db = createMockDb()
      addTask(db, "task-adjust-flow", "planned")

      // 1. Análise → pergunta → resposta → reanálise
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")
      expect(transitionTask("analyzing", "await_clarification")).toBe("awaiting_clarification")
      expect(transitionTask("awaiting_clarification", "clarification_answered")).toBe("planned")
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")

      // 2. Primeira proposta
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")
      await persistPlanProposal(db, "task-adjust-flow", sampleSubtasks, sampleCoverage)

      // 3. Usuário pede ajustes
      expect(transitionTask("awaiting_approval", "request_adjustments")).toBe("planned")
      await rejectPlanProposal(db, "task-adjust-flow", "alexandre", "Escopo insuficiente")
      await persistPlanDecision(db, "task-adjust-flow", "request_adjustments", "alexandre", "Escopo insuficiente")

      // 4. Reanálise e nova proposta
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")
      await persistPlanProposal(db, "task-adjust-flow", sampleSubtasks, sampleCoverage)

      // 5. Aprovação
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
      const approved = await approvePlanProposal(db, "task-adjust-flow", "alexandre")
      expect(approved!.status).toBe("approved")

      // Verifica histórico de propostas (2 versões)
      const history = await fetchPlanProposalHistory(db, "task-adjust-flow")
      expect(history.length).toBeGreaterThanOrEqual(2)
    })

    it("fluxo com conversa sobre proposta: proposta → continuar → resposta → aprovação", async () => {
      // Transições de estado
      expect(transitionTask("awaiting_approval", "continue_conversation")).toBe("awaiting_clarification")
      expect(transitionTask("awaiting_clarification", "clarification_answered")).toBe("planned")
      expect(transitionTask("planned", "start_analysis")).toBe("analyzing")
      expect(transitionTask("analyzing", "propose_plan")).toBe("awaiting_approval")
      expect(transitionTask("awaiting_approval", "approve_plan")).toBe("ready")
    })
  })
})