/**
 * PlanProposalStore - Persistência de propostas de plano
 *
 * Separa a representação estruturada do plano (subtarefas + dependências)
 * da execução efetiva. O analista apresenta uma proposta; o plano só é
 * materializado em subtarefas após aprovação explícita do dono.
 *
 * Fluxo:
 * 1. Analista apresenta proposta → persistPlanProposal (status: proposed)
 * 2. Dono aprova → approvePlanProposal (status: approved) → persistPlan cria subtarefas
 * 3. Dono pede ajustes → rejectPlanProposal (status: rejected) → reanálise na mesma sessão
 *
 * A proposta contém o JSON técnico completo (subtarefas, requisitos, cobertura)
 * validado pelo PlanQualityPolicy antes de ser persistida.
 */

import type { Db } from "../shared/types/infrastructure.js"
import type { PlanCoverage, PlannedSubtask } from "./PlanPersistence.js"

export type PlanProposalStatus = "proposed" | "approved" | "rejected"

export interface PlanProposal {
  id: number
  taskId: number
  version: number
  status: PlanProposalStatus
  subtasks: PlannedSubtask[]
  coverage: PlanCoverage
  proposedAt: string
  decidedAt: string | null
  decidedBy: string | null
  decisionReason: string | null
}

function taskLookup(taskId: string): { sql: string; params: unknown[] } {
  if (/^\d+$/.test(taskId)) {
    return {
      sql: "SELECT id FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1",
      params: [taskId, taskId],
    }
  }
  return {
    sql: "SELECT id FROM tarefas WHERE external_id = ? LIMIT 1",
    params: [taskId],
  }
}

async function resolveTaskDatabaseId(db: Db, taskId: string): Promise<number> {
  const lookup = taskLookup(taskId)
  const { rows } = await db.query(lookup.sql, lookup.params)
  const databaseTaskId = Number(rows[0]?.id ?? 0)
  if (!databaseTaskId) throw new Error("Tarefa não encontrada: " + taskId)
  return databaseTaskId
}

function mapRow(row: Record<string, unknown>): PlanProposal {
  const subtasksRaw = typeof row.subtasks_json === "string" ? JSON.parse(row.subtasks_json) : []
  const coverageRaw = typeof row.coverage_json === "string" ? JSON.parse(row.coverage_json) : { requirements: [], coverage: [] }
  return {
    id: Number(row.id),
    taskId: Number(row.tarefa_id),
    version: Number(row.version),
    status: String(row.status) as PlanProposalStatus,
    subtasks: Array.isArray(subtasksRaw) ? subtasksRaw : [],
    coverage: coverageRaw as PlanCoverage,
    proposedAt: String(row.proposed_at ?? ""),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    decisionReason: row.decision_reason == null ? null : String(row.decision_reason),
  }
}

/**
 * Persiste uma nova versão da proposta de plano.
 * Cada proposta recebe um version incremental; a versão anterior é mantida
 * para auditoria (não é apagada).
 */
export async function persistPlanProposal(
  db: Db,
  taskId: string,
  subtasks: readonly PlannedSubtask[],
  coverage: PlanCoverage,
): Promise<PlanProposal> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)

  // Busca a versão mais recente para incrementar
  const { rows: versionRows } = await db.query(
    "SELECT COALESCE(MAX(version), 0) AS max_version FROM motor_plan_proposals WHERE tarefa_id = ?",
    [databaseTaskId],
  )
  const nextVersion = Number(versionRows[0]?.max_version ?? 0) + 1

  await db.query(
    "INSERT INTO motor_plan_proposals (tarefa_id, version, status, subtasks_json, coverage_json, proposed_at) VALUES (?, ?, 'proposed', ?, ?, NOW())",
    [databaseTaskId, nextVersion, JSON.stringify(subtasks), JSON.stringify(coverage)],
  )

  const { rows } = await db.query(
    "SELECT id, tarefa_id, version, status, subtasks_json, coverage_json, proposed_at, decided_at, decided_by, decision_reason FROM motor_plan_proposals WHERE tarefa_id = ? AND version = ? LIMIT 1",
    [databaseTaskId, nextVersion],
  )
  if (!rows[0]) throw new Error("Falha ao persistir proposta de plano para tarefa " + taskId)
  return mapRow(rows[0])
}

/**
 * Aprova a proposta mais recente. Retorna a proposta aprovada para que o
 * chamador possa materializar as subtarefas via persistPlan.
 */
export async function approvePlanProposal(
  db: Db,
  taskId: string,
  decidedBy: string = "user",
  reason?: string,
): Promise<PlanProposal | null> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)

  const { rows } = await db.query(
    "SELECT id, tarefa_id, version, status, subtasks_json, coverage_json, proposed_at, decided_at, decided_by, decision_reason FROM motor_plan_proposals WHERE tarefa_id = ? AND status = 'proposed' ORDER BY version DESC LIMIT 1",
    [databaseTaskId],
  )
  if (!rows[0]) return null

  await db.query(
    "UPDATE motor_plan_proposals SET status = 'approved', decided_at = NOW(), decided_by = ?, decision_reason = ? WHERE id = ?",
    [decidedBy, reason ?? null, rows[0].id],
  )

  return { ...mapRow(rows[0]), status: "approved", decidedAt: new Date().toISOString(), decidedBy, decisionReason: reason ?? null }
}

/**
 * Rejeita a proposta mais recente (pedido de ajustes). A proposta é marcada
 * como rejected; uma nova versão pode ser criada na próxima rodada de análise.
 */
export async function rejectPlanProposal(
  db: Db,
  taskId: string,
  decidedBy: string = "user",
  reason?: string,
): Promise<PlanProposal | null> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)

  const { rows } = await db.query(
    "SELECT id, tarefa_id, version, status, subtasks_json, coverage_json, proposed_at, decided_at, decided_by, decision_reason FROM motor_plan_proposals WHERE tarefa_id = ? AND status = 'proposed' ORDER BY version DESC LIMIT 1",
    [databaseTaskId],
  )
  if (!rows[0]) return null

  await db.query(
    "UPDATE motor_plan_proposals SET status = 'rejected', decided_at = NOW(), decided_by = ?, decision_reason = ? WHERE id = ?",
    [decidedBy, reason ?? null, rows[0].id],
  )

  return { ...mapRow(rows[0]), status: "rejected", decidedAt: new Date().toISOString(), decidedBy, decisionReason: reason ?? null }
}

/**
 * Busca a proposta aprovada mais recente (se existir). Usado antes de
 * materializar subtarefas para garantir que há aprovação explícita.
 */
export async function fetchApprovedPlanProposal(
  db: Db,
  taskId: string,
): Promise<PlanProposal | null> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)

  const { rows } = await db.query(
    "SELECT id, tarefa_id, version, status, subtasks_json, coverage_json, proposed_at, decided_at, decided_by, decision_reason FROM motor_plan_proposals WHERE tarefa_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1",
    [databaseTaskId],
  )
  if (!rows[0]) return null
  return mapRow(rows[0])
}

/**
 * Busca a proposta pendente (proposed) mais recente. Usado pelo detail da
 * tarefa para exibir a proposta aguardando aprovação.
 */
export async function fetchPendingPlanProposal(
  db: Db,
  taskId: string,
): Promise<PlanProposal | null> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)

  const { rows } = await db.query(
    "SELECT id, tarefa_id, version, status, subtasks_json, coverage_json, proposed_at, decided_at, decided_by, decision_reason FROM motor_plan_proposals WHERE tarefa_id = ? AND status = 'proposed' ORDER BY version DESC LIMIT 1",
    [databaseTaskId],
  )
  if (!rows[0]) return null
  return mapRow(rows[0])
}

/**
 * Histórico de propostas da tarefa (todas as versões, em ordem cronológica).
 * Usado para auditoria das transições de plano.
 */
export async function fetchPlanProposalHistory(
  db: Db,
  taskId: string,
): Promise<PlanProposal[]> {
  const databaseTaskId = await resolveTaskDatabaseId(db, taskId)

  const { rows } = await db.query(
    "SELECT id, tarefa_id, version, status, subtasks_json, coverage_json, proposed_at, decided_at, decided_by, decision_reason FROM motor_plan_proposals WHERE tarefa_id = ? ORDER BY version ASC",
    [databaseTaskId],
  )
  return rows.map(mapRow)
}
