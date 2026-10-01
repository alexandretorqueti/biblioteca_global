import type { Pool, RowDataPacket } from 'mysql2/promise'
import { createTaskBlockedMessage } from './TaskBlockedEvent.js'
import type { QueueMessage } from '../queue/index.js'

interface OrphanBlockerRow extends RowDataPacket {
  block_id: number
  tarefa_id: number
  task_id: string
  block_reason: string
  block_command: string | null
  block_excerpt: string | null
  subtarefa_id: number | null
}

export interface MonitorBlockerReconcilerConfig {
  enqueue: (message: QueueMessage) => Promise<void>
  destinationQueue?: string
  intervalMs?: number
}

/** Reemite bloqueios ativos que perderam seu TASK_BLOCKED enquanto o Monitor estava pausado. */
export class MonitorBlockerReconciler {
  private timer: NodeJS.Timeout | null = null
  private reconciling = false
  private readonly intervalMs: number
  private readonly destinationQueue: string

  constructor(
    private readonly pool: Pool,
    private readonly config: MonitorBlockerReconcilerConfig,
  ) {
    this.intervalMs = config.intervalMs ?? 30_000
    this.destinationQueue = config.destinationQueue ?? 'motor.monitor'
  }

  /** Uma passagem é segura para repetir e não atua enquanto o Monitor está pausado. */
  async reconcile(): Promise<number> {
    if (this.reconciling) return 0
    this.reconciling = true
    try {
      const [activeRows] = await this.pool.query<Array<RowDataPacket & { valor: boolean | number | string | null }>>(
        `SELECT valor FROM motor_configuracoes WHERE chave = 'motor.monitor.active' LIMIT 1`,
      )
      if (!isActive(activeRows[0]?.valor)) return 0

      const [rows] = await this.pool.query<OrphanBlockerRow[]>(
        `SELECT b.id AS block_id, b.tarefa_id, b.block_reason, b.block_command,
                b.block_excerpt, b.subtarefa_id,
                COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id
           FROM bloqueios b
           INNER JOIN tarefas t ON t.id = b.tarefa_id
          WHERE b.resolved_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM motor_outbox o
               WHERE o.type = 'TASK_BLOCKED'
                 AND o.destination_queue = ?
                 AND o.status = 'pending'
                 AND JSON_UNQUOTE(JSON_EXTRACT(o.payload_json, '$.blockId')) = CAST(b.id AS CHAR)
            )
          ORDER BY b.id`,
        [this.destinationQueue],
      )

      let requeued = 0
      for (const row of rows) {
        await this.config.enqueue(createTaskBlockedMessage({
          taskId: row.task_id,
          executionId: `monitor-reconcile-${row.block_id}-${Date.now()}`,
          payload: {
            blockId: Number(row.block_id),
            databaseTaskId: Number(row.tarefa_id),
            blockReason: String(row.block_reason ?? ''),
            blockCommand: row.block_command,
            blockExcerpt: row.block_excerpt,
            subtaskId: row.subtarefa_id == null ? null : Number(row.subtarefa_id),
            resumeReason: 'monitor_reactivation_reconciliation',
          },
        }))
        requeued += 1
      }
      return requeued
    } catch (error) {
      console.error('[MonitorBlockerReconciler] falha na reconciliação:', error instanceof Error ? error.message : error)
      return 0
    } finally {
      this.reconciling = false
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

function isActive(value: boolean | number | string | null | undefined): boolean {
  if (value == null) return true
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return value === 'true' || value === '1'
}
