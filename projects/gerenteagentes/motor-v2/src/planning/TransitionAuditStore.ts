/**
 * TransitionAuditStore - Auditoria enriquecida de transições de tarefa
 *
 * Complementa o `tarefas_status_historico` com contexto completo:
 * - Sessão do analista ativa durante a transição
 * - Proposta de plano envolvida (aprovação/rejeição)
 * - Decisão do usuário (approve/request_adjustments/continue_conversation)
 * - Última mensagem do chat antes da transição
 * - Execution/worker context
 *
 * Permite:
 * 1. Reconstruir o histórico completo de uma tarefa após reinício
 * 2. Auditar o fluxo de conversa → proposta → decisão → execução
 * 3. Consultar dados persistidos sem perder o vínculo tarefa ↔ sessão
 */

import type { Db } from "../shared/types/infrastructure.js"

export type AuditDecisionType = "approve" | "request_adjustments" | "continue_conversation" | null

export interface TransitionAuditEntry {
  id: number
  taskId: number
  transition: string
  statusAnterior: string
  statusNovo: string
  analystSessionId: number | null
  planProposalId: number | null
  planProposalVersion: number | null
  decisionType: AuditDecisionType
  decisionActor: string | null
  decisionReason: string | null
  executionId: string | null
  workerId: string | null
  lastChatMessageId: number | null
  motivo: string | null
  occurredAt: string
  createdAt: string
}

export interface PersistTransitionAuditInput {
  taskId: number
  transition: string
  statusAnterior: string
  statusNovo: string
  analystSessionId?: number
  planProposalId?: number
  planProposalVersion?: number
  decisionType?: AuditDecisionType
  decisionActor?: string
  decisionReason?: string
  executionId?: string
  workerId?: string
  lastChatMessageId?: number
  motivo?: string
}

function mapRow(row: Record<string, unknown>): TransitionAuditEntry {
  return {
    id: Number(row.id),
    taskId: Number(row.tarefa_id),
    transition: String(row.transition ?? ""),
    statusAnterior: String(row.status_anterior ?? ""),
    statusNovo: String(row.status_novo ?? ""),
    analystSessionId: row.analyst_session_id == null ? null : Number(row.analyst_session_id),
    planProposalId: row.plan_proposal_id == null ? null : Number(row.plan_proposal_id),
    planProposalVersion: row.plan_proposal_version == null ? null : Number(row.plan_proposal_version),
    decisionType: (row.decision_type as AuditDecisionType) ?? null,
    decisionActor: row.decision_actor == null ? null : String(row.decision_actor),
    decisionReason: row.decision_reason == null ? null : String(row.decision_reason),
    executionId: row.execution_id == null ? null : String(row.execution_id),
    workerId: row.worker_id == null ? null : String(row.worker_id),
    lastChatMessageId: row.last_chat_message_id == null ? null : Number(row.last_chat_message_id),
    motivo: row.motivo == null ? null : String(row.motivo),
    occurredAt: String(row.occurred_at ?? ""),
    createdAt: String(row.created_at ?? ""),
  }
}

/**
 * Persiste uma entrada de auditoria de transição com contexto completo.
 * Chamado pelo coordenador após cada saveTaskTransition bem-sucedida.
 */
export async function persistTransitionAudit(
  db: Db,
  input: PersistTransitionAuditInput,
): Promise<void> {
  await db.query(
    `INSERT INTO motor_task_transition_audit
      (tarefa_id, transition, status_anterior, status_novo,
       analyst_session_id, plan_proposal_id, plan_proposal_version,
       decision_type, decision_actor, decision_reason,
       execution_id, worker_id, last_chat_message_id, motivo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.taskId,
      input.transition,
      input.statusAnterior,
      input.statusNovo,
      input.analystSessionId ?? null,
      input.planProposalId ?? null,
      input.planProposalVersion ?? null,
      input.decisionType ?? null,
      input.decisionActor ?? null,
      input.decisionReason ?? null,
      input.executionId ?? null,
      input.workerId ?? null,
      input.lastChatMessageId ?? null,
      input.motivo ?? null,
    ],
  )
}

/**
 * Histórico completo de transições de uma tarefa, em ordem cronológica.
 * Usado para auditoria e para reconstruir o estado após reinício.
 */
export async function fetchTransitionAudit(
  db: Db,
  taskId: number,
): Promise<TransitionAuditEntry[]> {
  const { rows } = await db.query(
    `SELECT id, tarefa_id, transition, status_anterior, status_novo,
            analyst_session_id, plan_proposal_id, plan_proposal_version,
            decision_type, decision_actor, decision_reason,
            execution_id, worker_id, last_chat_message_id, motivo,
            occurred_at, created_at
     FROM motor_task_transition_audit
     WHERE tarefa_id = ?
     ORDER BY occurred_at ASC, id ASC`,
    [taskId],
  )
  return rows.map(mapRow)
}

/**
 * Busca transições filtradas por tipo (ex.: apenas decisões de plano).
 */
export async function fetchTransitionAuditByType(
  db: Db,
  taskId: number,
  transition: string,
): Promise<TransitionAuditEntry[]> {
  const { rows } = await db.query(
    `SELECT id, tarefa_id, transition, status_anterior, status_novo,
            analyst_session_id, plan_proposal_id, plan_proposal_version,
            decision_type, decision_actor, decision_reason,
            execution_id, worker_id, last_chat_message_id, motivo,
            occurred_at, created_at
     FROM motor_task_transition_audit
     WHERE tarefa_id = ? AND transition = ?
     ORDER BY occurred_at ASC`,
    [taskId, transition],
  )
  return rows.map(mapRow)
}

/**
 * Última transição registrada para uma tarefa.
 * Usado para verificar o estado atual e o contexto da última ação.
 */
export async function fetchLastTransitionAudit(
  db: Db,
  taskId: number,
): Promise<TransitionAuditEntry | null> {
  const { rows } = await db.query(
    `SELECT id, tarefa_id, transition, status_anterior, status_novo,
            analyst_session_id, plan_proposal_id, plan_proposal_version,
            decision_type, decision_actor, decision_reason,
            execution_id, worker_id, last_chat_message_id, motivo,
            occurred_at, created_at
     FROM motor_task_transition_audit
     WHERE tarefa_id = ?
     ORDER BY occurred_at DESC, id DESC
     LIMIT 1`,
    [taskId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

// ============================================================================
// RECUPERAÇÃO UNIFICADA APÓS REINÍCIO
// ============================================================================

export interface TaskConversationRecovery {
  /** Tarefa existe e foi encontrada */
  found: boolean
  /** ID numérico da tarefa no banco */
  taskDatabaseId: number | null
  /** Sessão do analista ativa (se existir) */
  analystSession: {
    id: number
    agentId: string
    model: string
    sessionKey: string
    runtimeSessionId: string | null
    status: string
  } | null
  /** Histórico de mensagens do chat (analyst/user em ordem) */
  chatHistory: Array<{
    id: number
    role: string
    author: string | null
    texto: string
    createdAt: string
  }>
  /** Proposta de plano pendente (proposed), se existir */
  pendingProposal: {
    id: number
    version: number
    subtasksJson: string
    coverageJson: string
    proposedAt: string
  } | null
  /** Última transição registrada */
  lastTransition: {
    transition: string
    statusNovo: string
    occurredAt: string
  } | null
}

/**
 * Recuperação unificada do contexto completo de uma tarefa.
 *
 * Retorna tudo que é necessário para retomar uma tarefa após reinício:
 * - Sessão do analista (para continuar a conversa na mesma sessão)
 * - Histórico de mensagens (para reinjetar contexto no prompt)
 * - Proposta pendente (para exibir na tela de aprovação)
 * - Última transição (para verificar o estado atual)
 *
 * Projetado para ser chamado pelo pump do motor ao retomar tarefas
 * em estados de conversa (awaiting_clarification, awaiting_approval).
 */
export async function fetchTaskConversationRecovery(
  db: Db,
  taskId: string,
): Promise<TaskConversationRecovery> {
  // Resolve task ID
  const isNumeric = /^\d+$/.test(taskId)
  const taskLookupSql = isNumeric
    ? "SELECT id FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1"
    : "SELECT id FROM tarefas WHERE external_id = ? LIMIT 1"
  const taskLookupParams = isNumeric ? [taskId, taskId] : [taskId]

  const { rows: taskRows } = await db.query(taskLookupSql, taskLookupParams)
  if (!taskRows[0]) {
    return { found: false, taskDatabaseId: null, analystSession: null, chatHistory: [], pendingProposal: null, lastTransition: null }
  }
  const taskDatabaseId = Number(taskRows[0].id)

  // Busca sessão do analista (paralelizar queries independentes)
  const { rows: sessionRows } = await db.query(
    `SELECT id, agent_id, model, session_key, runtime_session_id, status
     FROM motor_task_analyst_sessions
     WHERE tarefa_id = ? AND status = 'active'
     LIMIT 1`,
    [taskDatabaseId],
  )

  // Busca histórico do chat
  const { rows: chatRows } = await db.query(
    `SELECT id, role, author, texto, created_at
     FROM tarefa_chats
     WHERE tarefa_id = ? AND role IN ('analyst', 'user')
     ORDER BY id ASC`,
    [taskDatabaseId],
  )

  // Busca proposta pendente
  const { rows: proposalRows } = await db.query(
    `SELECT id, version, subtasks_json, coverage_json, proposed_at
     FROM motor_plan_proposals
     WHERE tarefa_id = ? AND status = 'proposed'
     ORDER BY version DESC
     LIMIT 1`,
    [taskDatabaseId],
  )

  // Busca última transição
  const { rows: transitionRows } = await db.query(
    `SELECT transition, status_novo, occurred_at
     FROM motor_task_transition_audit
     WHERE tarefa_id = ?
     ORDER BY occurred_at DESC, id DESC
     LIMIT 1`,
    [taskDatabaseId],
  )

  return {
    found: true,
    taskDatabaseId,
    analystSession: sessionRows[0]
      ? {
          id: Number(sessionRows[0].id),
          agentId: String(sessionRows[0].agent_id ?? ""),
          model: String(sessionRows[0].model ?? ""),
          sessionKey: String(sessionRows[0].session_key ?? ""),
          runtimeSessionId: sessionRows[0].runtime_session_id == null ? null : String(sessionRows[0].runtime_session_id),
          status: String(sessionRows[0].status ?? ""),
        }
      : null,
    chatHistory: chatRows.map((row) => ({
      id: Number(row.id),
      role: String(row.role ?? ""),
      author: row.author == null ? null : String(row.author),
      texto: String(row.texto ?? ""),
      createdAt: String(row.created_at ?? ""),
    })),
    pendingProposal: proposalRows[0]
      ? {
          id: Number(proposalRows[0].id),
          version: Number(proposalRows[0].version),
          subtasksJson: String(proposalRows[0].subtasks_json ?? "{}"),
          coverageJson: String(proposalRows[0].coverage_json ?? "{}"),
          proposedAt: String(proposalRows[0].proposed_at ?? ""),
        }
      : null,
    lastTransition: transitionRows[0]
      ? {
          transition: String(transitionRows[0].transition ?? ""),
          statusNovo: String(transitionRows[0].status_novo ?? ""),
          occurredAt: String(transitionRows[0].occurred_at ?? ""),
        }
      : null,
  }
}

/**
 * Vincula uma tarefa à sua sessão de analista para consulta.
 * Retorna os dados da sessão associada à tarefa (se existir).
 */
export async function fetchTaskAnalystSessionLink(
  db: Db,
  taskId: number,
): Promise<{ sessionId: number; sessionKey: string; agentId: string; model: string; status: string } | null> {
  const { rows } = await db.query(
    `SELECT id, session_key, agent_id, model, status
     FROM motor_task_analyst_sessions
     WHERE tarefa_id = ?
     LIMIT 1`,
    [taskId],
  )
  if (!rows[0]) return null
  return {
    sessionId: Number(rows[0].id),
    sessionKey: String(rows[0].session_key ?? ""),
    agentId: String(rows[0].agent_id ?? ""),
    model: String(rows[0].model ?? ""),
    status: String(rows[0].status ?? ""),
  }
}
