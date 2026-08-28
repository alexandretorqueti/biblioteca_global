/**
 * ExpirationReconciler - Detecta locks expirados e retoma tarefas
 */

import type { Db } from '../shared/types/infrastructure.js'
import type { ResourceKey } from '../shared/types/resources.js'
import { resourceEventBus } from '../resources/ResourceEventBus.js'

export interface ExpirationReconcilerConfig {
  db: Db
  intervalMs?: number
  maxStalenessMs?: number
}

export class ExpirationReconciler {
  private db: Db
  private intervalMs: number
  private maxStalenessMs: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(config: ExpirationReconcilerConfig) {
    this.db = config.db
    this.intervalMs = config.intervalMs ?? 30000
    this.maxStalenessMs = config.maxStalenessMs ?? 120000
  }

  start(): void {
    if (this.timer) return
    console.log(`[ExpirationReconciler] Iniciando (${this.intervalMs}ms)`)
    this.timer = setInterval(() => { this.reconcile().catch(console.error) }, this.intervalMs)
    this.reconcile().catch(console.error)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async reconcile(): Promise<void> {
    const now = new Date()
    const staleThreshold = new Date(now.getTime() - this.maxStalenessMs)

    // 1. Locks expirados
    const expired = await this.db.query(
      `SELECT resource_key, execution_id FROM projeto_640.execution_resources WHERE expires_at < ?`,
      [now]
    )

    for (const row of expired.rows) {
      const key = String(row.resource_key!) as ResourceKey
      const execId = String(row.execution_id!)
      console.log(`[ExpirationReconciler] Lock expirado: ${key}`)

      await this.db.query(
        `DELETE FROM projeto_640.execution_resources WHERE resource_key = ? AND execution_id = ?`,
        [key, execId]
      )

      resourceEventBus.publish({ type: 'expired', resourceKey: key, executionId: execId, timestamp: now })
    }

    // 2. Tarefas órfãs (running sem lock)
    const orphans = await this.db.query(
      `SELECT t.id FROM projeto_640.tarefas t
       WHERE t.status = 'running'
         AND NOT EXISTS (
           SELECT 1 FROM projeto_640.execution_resources r
           WHERE r.execution_id LIKE CONCAT('%', t.id, '%') AND r.expires_at > ?
         )`,
      [now]
    )

    for (const row of orphans.rows) {
      const taskId = String(row.id!)
      console.log(`[ExpirationReconciler] Tarefa órfã: ${taskId}`)
      await this.db.query(
        `UPDATE projeto_640.tarefas SET status = 'failed', error_message = 'Lock expirado', updated_at = NOW() WHERE id = ?`,
        [taskId]
      )
    }

    // 3. Tarefas pausadas há muito tempo
    const stalePaused = await this.db.query(
      `SELECT id FROM projeto_640.tarefas WHERE status = 'paused' AND paused_at < ?`,
      [staleThreshold]
    )

    for (const row of stalePaused.rows) {
      const taskId = String(row.id!)
      console.log(`[ExpirationReconciler] Tarefa pausada stale: ${taskId}`)
      await this.db.query(
        `UPDATE projeto_640.tarefas SET status = 'planned', resource_wait_key = NULL, resource_wait_position = NULL, paused_at = NULL, updated_at = NOW() WHERE id = ?`,
        [taskId]
      )
    }
  }
}
