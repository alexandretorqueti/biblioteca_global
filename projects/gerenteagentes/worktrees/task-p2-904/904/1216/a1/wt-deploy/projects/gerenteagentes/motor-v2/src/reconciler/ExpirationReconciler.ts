/**
 * ExpirationReconciler - Detecta locks expirados e retoma tarefas
 */

import type { Db } from '../shared/types/infrastructure.js'
import type { ResourceKey } from '../shared/types/resources.js'
import { resourceEventBus } from '../resources/ResourceEventBus.js'
import { createLogger, describeError } from '../shared/logger.js'

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
    this.intervalMs = config.intervalMs ?? 30000
    this.maxStalenessMs = config.maxStalenessMs ?? 120000
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
      `SELECT resource_key, execution_id FROM projeto_640.execution_resources WHERE expires_at < ?`,
      [now]
    )

    for (const row of expired.rows) {
      const key = String(row.resource_key!) as ResourceKey
      const execId = String(row.execution_id!)
      this.logger.info(`Lock expirado: ${key}`, { executionId: execId })

      await this.db.query(
        `DELETE FROM projeto_640.execution_resources WHERE resource_key = ? AND execution_id = ?`,
        [key, execId]
      )

      resourceEventBus.publish({ type: 'expired', resourceKey: key, executionId: execId, timestamp: now })
      await this.onLeaseExpired?.(key, execId)
    }

    // 2. Tarefas órfãs: o plano é preservado e a primeira subtarefa não
    // verificada volta à fila. Uma análise sem plano volta a `planned`.
    const orphans = await this.db.query(
      `SELECT t.id, t.external_id, t.status,
              EXISTS(SELECT 1 FROM projeto_640.subtarefas s WHERE s.tarefa_id = t.id) AS has_subtasks
       FROM projeto_640.tarefas t
       WHERE t.status IN ('analyzing', 'running')
         AND NOT EXISTS (
           SELECT 1 FROM projeto_640.execution_resources r
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
          `UPDATE projeto_640.subtarefas SET status = 'pending', updated_at = NOW()
           WHERE tarefa_id = ? AND status IN ('running', 'delivered', 'verifying', 'rejected')`,
          [taskId],
        )
      }
      await this.db.query(
        `UPDATE projeto_640.tarefas SET status = ?, updated_at = NOW() WHERE id = ?`,
        [hasSubtasks ? 'ready' : 'planned', taskId],
      )
    }
  }
}
