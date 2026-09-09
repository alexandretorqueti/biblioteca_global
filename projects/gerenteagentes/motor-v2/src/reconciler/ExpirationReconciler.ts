/**
 * ExpirationReconciler - Detecta locks expirados e retoma tarefas
 */

import type { Db } from '../shared/types/infrastructure.js'
import type { ResourceKey } from '../shared/types/resources.js'
import { resourceEventBus } from '../resources/ResourceEventBus.js'
import { createLogger, describeError } from '../shared/logger.js'
import { AGENT_RUN_FAILED_WITHOUT_REPLY } from '../policies/NoReplyFailurePolicy.js'

export interface ExpirationReconcilerConfig {
  db: Db
  intervalMs?: number
  maxStalenessMs?: number
  onLeaseExpired?: (resourceKey: ResourceKey, executionId: string) => void | Promise<void>
}

export class ExpirationReconciler {
  private logger = createLogger('ExpirationReconciler')
  private db: Db
  private intervalMs: number
  private maxStalenessMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private onLeaseExpired?: ExpirationReconcilerConfig['onLeaseExpired']

  constructor(config: ExpirationReconcilerConfig) {
    this.db = config.db
    // Defaults alinhados com o catálogo de configurações do motor
    this.intervalMs = config.intervalMs ?? 30000 // 30 segundos
    this.maxStalenessMs = config.maxStalenessMs ?? 120000 // 2 minutos
    this.onLeaseExpired = config.onLeaseExpired
  }

  start(): void {
    if (this.timer) return
    this.logger.info(`Iniciando (${this.intervalMs}ms)`)
    this.timer = setInterval(() => { this.reconcile().catch((error) => this.logger.error('Erro no reconcile: ' + describeError(error))) }, this.intervalMs)
    this.reconcile().catch((error) => this.logger.error('Erro no reconcile: ' + describeError(error)))
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async reconcile(): Promise<void> {
    const now = new Date()
    // 1. Locks expirados
    const expired = await this.db.query(
      `SELECT resource_key, execution_id FROM execution_resources WHERE expires_at < ?`,
      [now]
    )

    for (const row of expired.rows) {
      const key = String(row.resource_key!) as ResourceKey
      const execId = String(row.execution_id!)
      this.logger.info(`Lock expirado: ${key}`, { executionId: execId })

      await this.db.query(
        `DELETE FROM execution_resources WHERE resource_key = ? AND execution_id = ?`,
        [key, execId]
      )

      resourceEventBus.publish({ type: 'expired', resourceKey: key, executionId: execId, timestamp: now })
      await this.onLeaseExpired?.(key, execId)
    }

    // Corrige registros legados onde a falha sem resposta foi persistida como
    // verified. Subtarefa e tarefa pai são alteradas atomicamente.
    await this.repairVerifiedNoReplySubtasks()

    // 2. Tarefas órfãs: o plano é preservado e a primeira subtarefa não
    // verificada volta à fila. Uma análise sem plano volta a `planned`.
    const orphans = await this.db.query(
      `SELECT t.id, t.external_id,
              EXISTS(SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id) AS has_subtasks
       FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
       WHERE f.terminal_status IS NULL
         AND (f.analysis_started_at IS NOT NULL OR EXISTS(SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status IN ('running', 'delivered', 'verifying')))
         AND NOT EXISTS (
           SELECT 1 FROM execution_resources r
           WHERE (r.owner_id = CAST(t.id AS CHAR) OR r.owner_id = t.external_id)
             AND r.expires_at > ?
         )`,
      [now]
    )

    for (const row of orphans.rows) {
      const taskId = String(row.id!)
      this.logger.info(`Tarefa órfã: ${taskId}`, { taskId })
      const hasSubtasks = Number(row.has_subtasks ?? 0) === 1
      if (hasSubtasks) {
        await this.db.query(
          `UPDATE subtarefas SET status = 'pending', updated_at = NOW()
           WHERE tarefa_id = ? AND status IN ('running', 'delivered', 'verifying', 'rejected')`,
          [taskId],
        )
      }
    }

    await this.repairOrphanedRunningSubtasks(now)
  }

  /**
   * Cobre a inconsistência em que o worker/lease some, mas apenas a subtarefa
   * fica `running` enquanto a tarefa-pai foi devolvida a `planned`/`ready`.
   * A consulta de tarefas órfãs acima não encontra esse formato.
   */
  private async repairOrphanedRunningSubtasks(now: Date): Promise<void> {
    const stale = await this.db.query(
      `SELECT s.id AS subtask_id, s.tarefa_id, t.external_id
       FROM subtarefas s
       INNER JOIN tarefas t ON t.id = s.tarefa_id
       LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
       WHERE s.status = 'running'
         AND f.terminal_status IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM execution_resources r
           WHERE (r.owner_id = CAST(t.id AS CHAR) OR r.owner_id = t.external_id)
             AND r.expires_at > ?
         )`,
      [now],
    )
    for (const row of stale.rows) {
      const subtaskId = Number(row.subtask_id)
      const taskId = Number(row.tarefa_id)
      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE subtarefas SET status = 'pending', updated_at = NOW(),
             resultado = CONCAT(COALESCE(resultado, ''), '\n[reconciliado] Worker/lease expirado; subtarefa devolvida à fila.')
           WHERE id = ? AND status = 'running'`,
          [subtaskId],
        )
      })
      this.logger.warn(`Subtarefa órfã reconciliada: ${subtaskId}`, { taskId: String(row.external_id) })
    }
  }

  private async repairVerifiedNoReplySubtasks(): Promise<void> {
    await this.db.transaction(async (tx) => {
      const affected = await tx.query(
        `SELECT DISTINCT s.tarefa_id FROM subtarefas s
         WHERE s.status = 'verified' AND TRIM(COALESCE(s.resultado, '')) = ?`,
        [AGENT_RUN_FAILED_WITHOUT_REPLY],
      )
      if (affected.rows.length === 0) return

      await tx.query(
        `UPDATE subtarefas SET status = 'pending', finalizada_em = NULL, updated_at = NOW()
         WHERE status = 'verified' AND TRIM(COALESCE(resultado, '')) = ?`,
        [AGENT_RUN_FAILED_WITHOUT_REPLY],
      )
      this.logger.warn(`Reparadas ${affected.rows.length} tarefa(s) com subtarefa verified sem resposta`)
    })
  }
}
