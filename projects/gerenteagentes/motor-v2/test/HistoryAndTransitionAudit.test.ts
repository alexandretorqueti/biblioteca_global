/**
 * Testes da subtarefa 9: Persistir histórico completo e auditoria de transições
 *
 * Critérios de aceite:
 * 1. Sessão, mensagens, proposta e decisões são persistidas
 * 2. Histórico preserva autoria, conteúdo, ordem e timestamps
 * 3. Transições de conversa, proposta, ajuste, aprovação e execução são auditáveis
 * 4. Após reinício, a tarefa retoma a sessão, o histórico, o estado e a proposta pendente
 * 5. Dados persistidos podem ser consultados sem perder o vínculo entre tarefa e sessão
 * 6. Compatibilidade com tarefas antigas em awaiting_clarification (sem author)
 */

import { describe, expect, it, vi } from "vitest"
import {
  persistTaskClarification,
  persistTaskClarificationAnswer,
  persistTaskAnalystMessage,
  persistTaskPlanProposal,
  persistPlanDecision,
  fetchTaskClarificationHistory,
  fetchPlanDecisions,
  formatHistoryForPrompt,
} from "../src/planning/ClarificationStore.js"
import {
  persistTransitionAudit,
  fetchTransitionAudit,
  fetchTransitionAuditByType,
  fetchLastTransitionAudit,
  fetchTaskConversationRecovery,
  fetchTaskAnalystSessionLink,
} from "../src/planning/TransitionAuditStore.js"
import {
  getOrReserveTaskAnalystSession,
  touchTaskAnalystSession,
} from "../src/planning/AnalystSessionStore.js"
import {
  persistPlanProposal,
  approvePlanProposal,
  fetchPendingPlanProposal,
} from "../src/planning/PlanProposalStore.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

// ============================================================================
// MOCK DB
// ============================================================================

function createMockDb(): Db & { _data: MockData } {
  const data: MockData = {
    tasks: [{ id: 100, external_id: "task-test-1" }],
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

interface MockData {
  tasks: Array<{ id: number; external_id: string }>
  chats: Array<Record<string, unknown>>
  sessions: Array<Record<string, unknown>>
  proposals: Array<Record<string, unknown>>
  transitions: Array<Record<string, unknown>>
  chatIdSeq: number
  sessionIdSeq: number
  proposalIdSeq: number
  transitionIdSeq: number
}

function handleQuery(data: MockData, sql: string, params: unknown[]): QueryResult {
  const normalized = sql.replace(/\s+/g, " ").trim()

  // Task lookup
  if (normalized.includes("FROM tarefas WHERE external_id")) {
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

  // SELECT tarefa_chats (history)
  if (normalized.includes("FROM tarefa_chats") && normalized.includes("role IN")) {
    const taskId = Number(params[0])
    const found = data.chats.filter(
      (c) => Number(c.tarefa_id) === taskId && (c.role === "analyst" || c.role === "user")
    )
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

  // INSERT motor_task_analyst_sessions
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

  // SELECT motor_task_analyst_sessions
  if (normalized.includes("FROM motor_task_analyst_sessions") && normalized.includes("WHERE tarefa_id")) {
    const taskId = Number(params[0])
    const found = data.sessions.filter((s) => Number(s.tarefa_id) === taskId)
    return { rows: found, affectedRows: 0, insertId: 0 }
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

  // SELECT motor_plan_proposals (version)
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

  // SELECT motor_task_transition_audit (last - must be checked before "all")
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

  // SELECT motor_task_transition_audit (all)
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

  // SELECT motor_task_transition_audit (by transition)
  if (normalized.includes("FROM motor_task_transition_audit") && normalized.includes("transition =")) {
    const taskId = Number(params[0])
    const transition = String(params[1])
    const found = data.transitions.filter(
      (t) => Number(t.tarefa_id) === taskId && t.transition === transition
    )
    return { rows: found, affectedRows: 0, insertId: 0 }
  }

  // SELECT motor_task_analyst_sessions (active, for recovery)
  if (normalized.includes("FROM motor_task_analyst_sessions") && normalized.includes("status = 'active'")) {
    const taskId = Number(params[0])
    const found = data.sessions.filter(
      (s) => Number(s.tarefa_id) === taskId && s.status === "active"
    )
    return { rows: found, affectedRows: 0, insertId: 0 }
  }

  return { rows: [], affectedRows: 0, insertId: 0 }
}

// ============================================================================
// TESTES
// ============================================================================

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
]

const sampleCoverage = {
  requirements: [{ id: "REQ-1", description: "Validação de entrada" }],
  coverage: [{ requirement: "REQ-1", coveredBy: [1] }],
}

describe("Subtarefa 9: Persistência de histórico e auditoria", () => {
  describe("Critério 1: Sessão, mensagens, proposta e decisões são persistidas", () => {
    it("persiste sessão do analista vinculada à tarefa", async () => {
      const db = createMockDb()
      const session = await getOrReserveTaskAnalystSession(db, "task-test-1", {
        agentId: "analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-test-1",
      })
      expect(session.sessionKey).toBe("analysis-task-test-1")
      expect(session.agentId).toBe("analyst")
      expect(db._data.sessions).toHaveLength(1)
    })

    it("persiste mensagens com autor no chat da tarefa", async () => {
      const db = createMockDb()
      await persistTaskClarification(db, "task-test-1", { summary: "s", questions: ["p?"] }, "analyst-gpt4")
      await persistTaskClarificationAnswer(db, "task-test-1", "resposta", "alexandre")

      expect(db._data.chats).toHaveLength(2)
      expect(db._data.chats[0]!.author).toBe("analyst-gpt4")
      expect(db._data.chats[0]!.role).toBe("analyst")
      expect(db._data.chats[1]!.author).toBe("alexandre")
      expect(db._data.chats[1]!.role).toBe("user")
    })

    it("persiste proposta de plano com versão", async () => {
      const db = createMockDb()
      const proposal = await persistPlanProposal(db, "task-test-1", sampleSubtasks, sampleCoverage)
      expect(proposal.version).toBe(1)
      expect(proposal.status).toBe("proposed")
      expect(db._data.proposals).toHaveLength(1)
    })

    it("persiste decisão de aprovação no chat", async () => {
      const db = createMockDb()
      await persistPlanDecision(db, "task-test-1", "approve", "alexandre", null)
      expect(db._data.chats).toHaveLength(1)
      expect(db._data.chats[0]!.author).toBe("alexandre")
      expect(String(db._data.chats[0]!.texto)).toContain("✅")
    })
  })

  describe("Critério 2: Histórico preserva autoria, conteúdo, ordem e timestamps", () => {
    it("retorna histórico com autor, conteúdo e ordem", async () => {
      const db = createMockDb()
      await persistTaskClarification(db, "task-test-1", { summary: "Entendimento", questions: ["Q1?"] }, "analyst-gpt4")
      await persistTaskClarificationAnswer(db, "task-test-1", "R1", "alexandre")
      await persistTaskAnalystMessage(db, "task-test-1", "Explicação em texto natural", "analyst-gpt4")

      const history = await fetchTaskClarificationHistory(db, "task-test-1")
      expect(history).toHaveLength(3)
      expect(history[0]!.role).toBe("analyst")
      expect(history[0]!.author).toBe("analyst-gpt4")
      expect(history[0]!.texto).toContain("Q1?")
      expect(history[1]!.role).toBe("user")
      expect(history[1]!.author).toBe("alexandre")
      expect(history[1]!.texto).toBe("R1")
      expect(history[2]!.role).toBe("analyst")
      expect(history[2]!.author).toBe("analyst-gpt4")
      expect(history[2]!.texto).toContain("Explicação")
    })

    it("formatHistoryForPrompt inclui autor quando disponível", () => {
      const text = formatHistoryForPrompt([
        { role: "analyst", author: "analyst-gpt4", texto: "1) A ou B?", createdAt: "" },
        { role: "user", author: "alexandre", texto: "1: A", createdAt: "" },
        { role: "analyst", author: null, texto: "2) C?", createdAt: "" },
      ])
      expect(text).toContain("[ANALISTA (analyst-gpt4)]")
      expect(text).toContain("[RESPOSTA (alexandre)]")
      expect(text).toContain("[ANALISTA] 2) C?")
    })

    it("decisões mantêm ordem cronológica com autor", async () => {
      const db = createMockDb()
      await persistPlanDecision(db, "task-test-1", "continue_conversation", "alexandre", "Primeira pergunta")
      await persistPlanDecision(db, "task-test-1", "request_adjustments", "alexandre", "Escopo insuficiente")
      await persistPlanDecision(db, "task-test-1", "approve", "alexandre", null)

      const decisions = await fetchPlanDecisions(db, "task-test-1")
      expect(decisions).toHaveLength(3)
      expect(decisions[0]!.decision).toBe("continue_conversation")
      expect(decisions[0]!.actor).toBe("alexandre")
      expect(decisions[1]!.decision).toBe("request_adjustments")
      expect(decisions[2]!.decision).toBe("approve")
    })
  })

  describe("Critério 3: Transições são auditáveis", () => {
    it("persiste transição com contexto de sessão", async () => {
      const db = createMockDb()
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "await_clarification",
        statusAnterior: "analyzing",
        statusNovo: "awaiting_clarification",
        analystSessionId: 1,
      })

      const audit = await fetchTransitionAudit(db, 100)
      expect(audit).toHaveLength(1)
      expect(audit[0]!.transition).toBe("await_clarification")
      expect(audit[0]!.analystSessionId).toBe(1)
    })

    it("persiste transição de aprovação com contexto de proposta", async () => {
      const db = createMockDb()
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "approve_plan",
        statusAnterior: "awaiting_approval",
        statusNovo: "ready",
        planProposalId: 5,
        planProposalVersion: 2,
        decisionType: "approve",
        decisionActor: "alexandre",
      })

      const audit = await fetchTransitionAuditByType(db, 100, "approve_plan")
      expect(audit).toHaveLength(1)
      expect(audit[0]!.planProposalId).toBe(5)
      expect(audit[0]!.planProposalVersion).toBe(2)
      expect(audit[0]!.decisionType).toBe("approve")
      expect(audit[0]!.decisionActor).toBe("alexandre")
    })

    it("persiste transição de ajuste com motivo", async () => {
      const db = createMockDb()
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "request_adjustments",
        statusAnterior: "awaiting_approval",
        statusNovo: "planned",
        planProposalId: 5,
        planProposalVersion: 1,
        decisionType: "request_adjustments",
        decisionActor: "alexandre",
        decisionReason: "Escopo insuficiente para o requisito X",
      })

      const audit = await fetchTransitionAudit(db, 100)
      expect(audit).toHaveLength(1)
      expect(audit[0]!.decisionReason).toBe("Escopo insuficiente para o requisito X")
    })

    it("última transição é recuperável", async () => {
      const db = createMockDb()
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "start_analysis",
        statusAnterior: "planned",
        statusNovo: "analyzing",
      })
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "await_clarification",
        statusAnterior: "analyzing",
        statusNovo: "awaiting_clarification",
        analystSessionId: 1,
      })

      const last = await fetchLastTransitionAudit(db, 100)
      expect(last).not.toBeNull()
      expect(last!.transition).toBe("await_clarification")
      expect(last!.analystSessionId).toBe(1)
    })
  })

  describe("Critério 4: Após reinício, retoma sessão, histórico, estado e proposta pendente", () => {
    it("recupera contexto completo de tarefa em awaiting_clarification", async () => {
      const db = createMockDb()

      // Simula estado persistido antes do reinício
      await getOrReserveTaskAnalystSession(db, "task-test-1", {
        agentId: "analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-test-1",
      })
      await persistTaskClarification(db, "task-test-1", { summary: "s", questions: ["Q1?"] }, "analyst-gpt4")
      await persistTaskClarificationAnswer(db, "task-test-1", "R1", "alexandre")
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "await_clarification",
        statusAnterior: "analyzing",
        statusNovo: "awaiting_clarification",
        analystSessionId: 1,
      })

      // Recupera após "reinício"
      const recovery = await fetchTaskConversationRecovery(db, "task-test-1")
      expect(recovery.found).toBe(true)
      expect(recovery.taskDatabaseId).toBe(100)
      expect(recovery.analystSession).not.toBeNull()
      expect(recovery.analystSession!.sessionKey).toBe("analysis-task-test-1")
      expect(recovery.chatHistory).toHaveLength(2)
      expect(recovery.chatHistory[0]!.author).toBe("analyst-gpt4")
      expect(recovery.chatHistory[1]!.author).toBe("alexandre")
      expect(recovery.lastTransition).not.toBeNull()
      expect(recovery.lastTransition!.transition).toBe("await_clarification")
    })

    it("recupera proposta pendente em awaiting_approval", async () => {
      const db = createMockDb()

      await persistPlanProposal(db, "task-test-1", sampleSubtasks, sampleCoverage)
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "propose_plan",
        statusAnterior: "analyzing",
        statusNovo: "awaiting_approval",
        planProposalId: 1,
        planProposalVersion: 1,
      })

      const recovery = await fetchTaskConversationRecovery(db, "task-test-1")
      expect(recovery.pendingProposal).not.toBeNull()
      expect(recovery.pendingProposal!.version).toBe(1)
      expect(recovery.lastTransition!.transition).toBe("propose_plan")
    })

    it("retorna found=false para tarefa inexistente", async () => {
      const db = createMockDb()
      const recovery = await fetchTaskConversationRecovery(db, "task-inexistente")
      expect(recovery.found).toBe(false)
      expect(recovery.taskDatabaseId).toBeNull()
    })
  })

  describe("Critério 5: Dados persistidos podem ser consultados sem perder vínculo tarefa↔sessão", () => {
    it("vincula tarefa à sessão do analista", async () => {
      const db = createMockDb()
      await getOrReserveTaskAnalystSession(db, "task-test-1", {
        agentId: "analyst",
        model: "gpt-4",
        sessionKey: "analysis-task-test-1",
      })

      const link = await fetchTaskAnalystSessionLink(db, 100)
      expect(link).not.toBeNull()
      expect(link!.sessionId).toBe(1)
      expect(link!.sessionKey).toBe("analysis-task-test-1")
      expect(link!.agentId).toBe("analyst")
    })

    it("auditoria de transições referencia sessão e proposta", async () => {
      const db = createMockDb()
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "approve_plan",
        statusAnterior: "awaiting_approval",
        statusNovo: "ready",
        analystSessionId: 1,
        planProposalId: 5,
        planProposalVersion: 2,
        decisionType: "approve",
        decisionActor: "alexandre",
      })

      const audit = await fetchTransitionAudit(db, 100)
      expect(audit[0]!.analystSessionId).toBe(1)
      expect(audit[0]!.planProposalId).toBe(5)
      expect(audit[0]!.planProposalVersion).toBe(2)
    })
  })

  describe("Critério 6: Compatibilidade com tarefas legadas (sem author)", () => {
    it("mensagens sem author são recuperadas com author=null", async () => {
      const db = createMockDb()
      // Simula insert legado (sem author)
      await persistTaskClarification(db, "task-test-1", { summary: "s", questions: ["p?"] })
      await persistTaskClarificationAnswer(db, "task-test-1", "resposta")

      const history = await fetchTaskClarificationHistory(db, "task-test-1")
      expect(history).toHaveLength(2)
      expect(history[0]!.author).toBeNull()
      expect(history[1]!.author).toBeNull()
    })

    it("formatHistoryForPrompt funciona sem author (legado)", () => {
      const text = formatHistoryForPrompt([
        { role: "analyst", author: null, texto: "1) A ou B?", createdAt: "" },
        { role: "user", author: null, texto: "1: A", createdAt: "" },
      ])
      expect(text).toContain("[ANALISTA] 1) A ou B?")
      expect(text).toContain("[RESPOSTA] 1: A")
      expect(text).not.toContain("(null)")
    })

    it("transições sem contexto de sessão/proposta são registradas", async () => {
      const db = createMockDb()
      await persistTransitionAudit(db, {
        taskId: 100,
        transition: "start_analysis",
        statusAnterior: "planned",
        statusNovo: "analyzing",
      })

      const audit = await fetchTransitionAudit(db, 100)
      expect(audit).toHaveLength(1)
      expect(audit[0]!.analystSessionId).toBeNull()
      expect(audit[0]!.planProposalId).toBeNull()
    })
  })
})
