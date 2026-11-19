import type { Pool, RowDataPacket } from 'mysql2/promise'

interface ExpiredClaimRow extends RowDataPacket {
  message_id: string
  outbox_message_id: string | null
}

export interface MessageProcessingClaimReconcilerConfig {
  intervalMs?: number
  processingTimeoutSeconds?: number
}

export interface MessageProcessingClaimReconciliation {
  failed: number
  requeued: number
  withoutOutbox: number
}

/** Recupera claims de mensagens que ficaram processing após a morte do consumidor. */
export class MessageProcessingClaimReconciler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly intervalMs: number
  private readonly processingTimeoutSeconds: number

  constructor(
    private readonly pool: Pool,
    config: MessageProcessingClaimReconcilerConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 300_000
    this.processingTimeoutSeconds = config.processingTimeoutSeconds ?? 300
  }

  async reconcile(): Promise<MessageProcessingClaimReconciliation> {
    if (this.running) return { failed: 0, requeued: 0, withoutOutbox: 0 }
    this.running = true
    try {
      const [rows] = await this.pool.query<ExpiredClaimRow[]>(
        `SELECT state.message_id, outbox.message_id AS outbox_message_id
           FROM motor_message_processing_state state
           LEFT JOIN motor_outbox outbox ON outbox.message_id COLLATE utf8mb4_unicode_ci = state.message_id
          WHERE state.status = 'processing'
            AND (
              state.timeout_at < NOW()
              OR (state.timeout_at IS NULL AND state.started_at < DATE_SUB(NOW(), INTERVAL ? SECOND))
            )
          ORDER BY state.started_at, state.message_id`,
        [this.processingTimeoutSeconds],
      )
      const result: MessageProcessingClaimReconciliation = { failed: 0, requeued: 0, withoutOutbox: 0 }
      for (const row of rows) {
        const [updated] = await this.pool.query<any>(
          `UPDATE motor_message_processing_state
              SET status = 'failed', completed_at = NULL, timeout_at = NULL,
                  error_message = 'Claim de processamento expirado; mensagem recuperada pelo reconciliador'
            WHERE message_id = ? AND status = 'processing'
              AND (
                timeout_at < NOW()
                OR (timeout_at IS NULL AND started_at < DATE_SUB(NOW(), INTERVAL ? SECOND))
              )`,
          [row.message_id, this.processingTimeoutSeconds],
        )
        if (Number(updated?.affectedRows ?? 0) === 0) continue

        result.failed++
        if (row.outbox_message_id) {
          await this.pool.query(
            `UPDATE motor_outbox
                SET status = 'pending', published_at = NULL,
                    last_error = 'Republicada após expiração do claim de processamento', updated_at = NOW()
              WHERE message_id = ?`,
            [row.outbox_message_id],
          )
          result.requeued++
          console.warn(JSON.stringify({ event: 'message_processing_claim_requeued', message_id: row.message_id }))
        } else {
          result.withoutOutbox++
          console.warn(JSON.stringify({ event: 'message_processing_claim_expired_without_outbox', message_id: row.message_id }))
        }
      }
      return result
    } catch (error) {
      console.error('[MessageProcessingClaimReconciler] falha na reconciliação:', error instanceof Error ? error.message : error)
      return { failed: 0, requeued: 0, withoutOutbox: 0 }
    } finally {
      this.running = false
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
