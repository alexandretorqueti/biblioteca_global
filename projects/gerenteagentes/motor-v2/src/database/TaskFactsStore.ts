import { deriveTaskStatus, type DerivedTaskStatusFacts } from "../policies/DerivedTaskStatus.js"
import type { TaskStatus } from "../shared/types/index.js"
import type { Db } from "../shared/types/infrastructure.js"

export type TaskFactEvent =
  | "start_analysis"
  | "analysis_completed"
  | "integration_confirmed"
  | "cancelled"
  | "failed"

function taskLookup(taskId: string): { sql: string; params: unknown[] } {
  return /^\d+$/.test(taskId)
    ? { sql: "external_id = ? OR id = CAST(? AS UNSIGNED)", params: [taskId, taskId] }
    : { sql: "external_id = ?", params: [taskId] }
}

/** Fonte única dos fatos que determinam o status operacional da tarefa. */
export class TaskFactsStore {
  constructor(private readonly db: Db) {}

  async derive(taskId: string, legacyFallback?: TaskStatus): Promise<TaskStatus> {
    const lookup = taskLookup(taskId)
    const { rows } = await this.db.query(
      "SELECT t.id, t.paused_at, f.analysis_started_at, f.integration_confirmed_at, f.terminal_status, " +
      "EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS has_active_blocker, " +
      "(SELECT c.role FROM tarefa_chats c WHERE c.tarefa_id = t.id AND c.role IN ('analyst', 'user') ORDER BY c.id DESC LIMIT 1) AS last_clarification_role, " +
      "EXISTS(SELECT 1 FROM deploy_requests d WHERE d.tarefa_id = t.id AND d.status = 'succeeded') AS deploy_succeeded " +
      "FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id WHERE " + lookup.sql + " LIMIT 1",
      lookup.params,
    )
    const row = rows[0] as Record<string, unknown> | undefined
    // Compatibilidade de leitura para registros pré-migration e doubles de
    // teste: em produção, uma tarefa existente sempre retorna `id` aqui.
    if (!row || row.id == null) return legacyFallback ?? "planned"
    const { rows: subtaskRows } = await this.db.query(
      "SELECT s.status FROM subtarefas s WHERE s.tarefa_id = ?",
      [Number(row.id)],
    )
    const facts: DerivedTaskStatusFacts = {
      terminalStatus: row.terminal_status ? String(row.terminal_status) : null,
      hasPendingClarification: row.last_clarification_role === "analyst",
      hasActiveBlocker: Number(row.has_active_blocker ?? 0) === 1,
      analysisInProgress: row.analysis_started_at != null,
      hasPersistedPlan: subtaskRows.length > 0,
      subtaskStatuses: subtaskRows.map((subtask) => String(subtask.status)),
      deploySucceeded: Number(row.deploy_succeeded ?? 0) === 1,
      integrationConfirmed: row.integration_confirmed_at != null,
      pausedAt: row.paused_at ? String(row.paused_at) : null,
    }
    return deriveTaskStatus(facts)
  }

  async record(taskId: string, event: TaskFactEvent): Promise<void> {
    const lookup = taskLookup(taskId)
    const sqlByEvent: Record<TaskFactEvent, string> = {
      start_analysis: "analysis_started_at = NOW(), terminal_status = NULL, terminal_at = NULL",
      analysis_completed: "analysis_started_at = NULL",
      integration_confirmed: "analysis_started_at = NULL, integration_confirmed_at = NOW()",
      cancelled: "terminal_status = 'cancelled', terminal_at = NOW(), analysis_started_at = NULL",
      failed: "terminal_status = 'failed', terminal_at = NOW(), analysis_started_at = NULL",
    }
    await this.db.query(
      "INSERT INTO task_runtime_facts (tarefa_id, created_at, updated_at) " +
      "SELECT id, NOW(), NOW() FROM tarefas WHERE " + lookup.sql + " LIMIT 1 " +
      "ON DUPLICATE KEY UPDATE " + sqlByEvent[event] + ", updated_at = NOW()",
      lookup.params,
    )
  }

  async resolveBlocks(taskId: string): Promise<void> {
    const lookup = taskLookup(taskId)
    await this.db.query(
      "UPDATE bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id SET b.resolved_at = NOW() " +
      "WHERE (" + lookup.sql + ") AND b.resolved_at IS NULL",
      lookup.params,
    )
  }
}
