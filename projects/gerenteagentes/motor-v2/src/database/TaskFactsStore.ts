import { deriveTaskStatus, type DerivedTaskStatusFacts } from "../policies/DerivedTaskStatus.js"
import type { TaskStatus } from "../shared/types/index.js"
import type { Db } from "../shared/types/infrastructure.js"
import { verifyRecoveryEligibility, type RecoveryEligibility } from "../shared/recoveryEligibility.js"

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

  /** Lê os fatos persistidos e aplica o contrato canônico do selo de recuperação. */
  async recoveryEligibility(taskId: string, now = new Date()): Promise<RecoveryEligibility | null> {
    const lookup = taskLookup(taskId)
    const { rows } = await this.db.query(
      "SELECT t.id, COALESCE(f.terminal_status, t.status) AS derived_status FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id=t.id WHERE " + lookup.sql + " LIMIT 1", lookup.params,
    )
    const task = rows[0]
    if (!task) return null
    const taskIdNumber = Number(task.id)
    const { rows: blockers } = await this.db.query("SELECT b.id, b.subtarefa_id, b.block_reason, b.block_command, b.block_excerpt, COALESCE(b.blocked_at, s.updated_at) AS blocked_at, (b.id IS NULL) AS orphan FROM bloqueios b LEFT JOIN subtarefas s ON s.id=b.subtarefa_id WHERE b.tarefa_id=? AND b.resolved_at IS NULL ORDER BY b.blocked_at ASC, b.id ASC", [taskIdNumber])
    const { rows: orphans } = await this.db.query("SELECT NULL AS id, s.id AS subtarefa_id, '' AS block_reason, '' AS block_command, '' AS block_excerpt, s.updated_at AS blocked_at, 1 AS orphan FROM subtarefas s WHERE s.tarefa_id=? AND s.status='blocked' AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id=? AND b.resolved_at IS NULL)", [taskIdNumber, taskIdNumber])
    const { rows: retries } = await this.db.query("SELECT COUNT(*) AS total FROM bloqueios WHERE subtarefa_id IN (SELECT id FROM subtarefas WHERE tarefa_id=?) AND block_reason IN ('blocked_environment', 'systemic_failure', 'model_chain_exhausted') AND resolved_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)", [taskIdNumber])
    const { rows: leases } = await this.db.query("SELECT execution_id, owner_id, resource_key, expires_at FROM execution_resources WHERE resource_key='motor:monitor' AND expires_at > NOW() AND owner_id IN (SELECT CAST(id AS CHAR) FROM subtarefas WHERE tarefa_id=?) LIMIT 1", [taskIdNumber])
    const { rows: chats } = await this.db.query("SELECT id, role, texto, created_at FROM tarefa_chats WHERE tarefa_id=? AND role IN ('monitor','user') ORDER BY id DESC LIMIT 20", [taskIdNumber])
    const monitor = chats.find((chat) => chat.role === "monitor")
    const user = chats.find((chat) => chat.role === "user")
    const pendingQuestion = monitor && (!user || Number(user.id) < Number(monitor.id)) ? { messageId: Number(monitor.id), askedAt: String(monitor.created_at), text: String(monitor.texto ?? "") } : null
    return verifyRecoveryEligibility({
      status: String(task.derived_status ?? ""),
      blockers: [...blockers, ...orphans].map((row) => ({ id: row.id == null ? undefined : Number(row.id), subtarefaId: row.subtarefa_id == null ? null : Number(row.subtarefa_id), reason: String(row.block_reason ?? ""), command: String(row.block_command ?? ""), excerpt: String(row.block_excerpt ?? ""), blockedAt: row.blocked_at == null ? null : String(row.blocked_at), orphan: Number(row.orphan ?? 0) === 1 })),
      resolvedSystemBlockCount24h: Number(retries[0]?.total ?? 0),
      activeLease: leases[0] ? { executionId: String(leases[0].execution_id), ownerId: String(leases[0].owner_id), resourceKey: String(leases[0].resource_key), expiresAt: String(leases[0].expires_at) } : null,
      pendingQuestion,
      now,
    })
  }

  async derive(taskId: string, legacyFallback?: TaskStatus): Promise<TaskStatus> {
    const lookup = taskLookup(taskId)
    const { rows } = await this.db.query(
      "SELECT t.id, t.paused_at, t.resource_wait_key, f.analysis_started_at, f.integration_confirmed_at, f.terminal_status, " +
      "EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS has_active_blocker, " +
      "(SELECT c.role FROM tarefa_chats c WHERE c.tarefa_id = t.id AND c.role IN ('analyst', 'user') ORDER BY c.id DESC LIMIT 1) AS last_clarification_role, " +
      "EXISTS(SELECT 1 FROM deploy_requests d WHERE d.tarefa_id = t.id AND d.status = 'succeeded') AS deploy_succeeded, " +
      "EXISTS(SELECT 1 FROM deploy_requests d WHERE d.tarefa_id = t.id AND d.status = 'failed') AS deploy_failed " +
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
      deployFailed: Number(row.deploy_failed ?? 0) === 1,
      integrationConfirmed: row.integration_confirmed_at != null,
      pausedAt: row.paused_at ? String(row.paused_at) : null,
      resourceWaitKey: row.resource_wait_key ? String(row.resource_wait_key) : null,
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
