import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from './QueueMessage.js'
import type { QueueTransport } from './QueueTransport.js'

interface OutboxRow extends RowDataPacket {
  message_id: string
  type: string
  destination_queue: string | null
  task_id: string
  execution_id: string
  payload_json: string | Record<string, unknown>
  timestamp: Date | string
  correlation_id: string | null
  causation_id: string | null
  attempt: number
}

/** Converte o timestamp serializável da mensagem para DATETIME do MySQL. */
function toMysqlDateTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Timestamp inválido para o outbox: ${String(value)}`)
  }
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** Publica mensagens persistidas sem polling periódico. */
export class OutboxPublisher {
  private started = false
  private flushing = false
  private pollTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly pool: Pool,
    private readonly transport: QueueTransport,
    private readonly queue: string,
    private readonly destinationQueue: string = queue,
  ) {}

  async start(): Promise<void> {
    await this.transport.connect()
    this.started = true
    const recovered = await this.recoverAbandonedProcessing()
    if (recovered > 0) console.warn(`[OutboxPublisher] ${recovered} mensagem(ns) abandonada(s) recuperada(s) para reprocessamento`)
    await this.flush()
    // A API e o Motor compartilham o outbox, mas não o mesmo objeto em
    // memória. O polling garante que mensagens inseridas pela API sejam
    // publicadas sem depender de outro comando HTTP ou de um reinício.
    this.pollTimer = setInterval(() => {
      void this.flush().catch(error => console.error('[OutboxPublisher] falha no polling:', error))
    }, 1_000)
    this.pollTimer.unref()
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /** Reabre claims perdidos por reinício e republica sua mensagem pelo outbox. */
  private async recoverAbandonedProcessing(): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE motor_message_processing_state state
       INNER JOIN motor_outbox outbox
         ON outbox.message_id COLLATE utf8mb4_unicode_ci = state.message_id
       SET state.status = 'pending',
           state.started_at = NULL,
           state.completed_at = NULL,
           state.timeout_at = NULL,
           state.error_message = 'Recuperada após reinício do Motor',
           outbox.status = 'pending',
           outbox.last_error = 'Republicada após recuperação de processamento abandonado',
           outbox.updated_at = NOW()
       WHERE state.status = 'processing'
         AND state.started_at < DATE_SUB(NOW(), INTERVAL 300 SECOND)`,
    )
    return result.affectedRows
  }

  async enqueue(message: QueueMessage, destinationQueue = this.destinationQueue): Promise<void> {
    await this.pool.query<ResultSetHeader>(
      `INSERT INTO motor_outbox
        (message_id, type, destination_queue, task_id, execution_id, payload_json, timestamp, correlation_id, causation_id, status, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
       ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)`,
      [message.messageId, message.type, destinationQueue, message.taskId, message.executionId,
        JSON.stringify(message.payload), toMysqlDateTime(message.timestamp), message.correlationId ?? null,
        message.causationId ?? null],
    )
    if (this.started) await this.flush()
  }

  async flush(): Promise<void> {
    if (!this.started || this.flushing) return
    this.flushing = true
    try {
      const [rows] = await this.pool.query<OutboxRow[]>(
        `SELECT message_id, type, destination_queue, task_id, execution_id, payload_json, timestamp,
                correlation_id, causation_id, attempt
           FROM motor_outbox WHERE status = 'pending' AND destination_queue = ? AND timestamp <= NOW() ORDER BY id ASC LIMIT 100`,
        [this.destinationQueue],
      )
      for (const row of rows) await this.publishRow(row)
    } finally {
      this.flushing = false
    }
  }

  private async publishRow(row: OutboxRow): Promise<void> {
    const message: QueueMessage = {
      messageId: row.message_id,
      type: row.type,
      taskId: row.task_id,
      executionId: row.execution_id,
      payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
      timestamp: new Date(row.timestamp).toISOString(),
      ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
      ...(row.causation_id ? { causationId: row.causation_id } : {}),
      attempt: Number(row.attempt ?? 0) + 1,
    }
    try {
      await this.transport.publish(row.destination_queue ?? this.queue, message, { messageId: message.messageId, persistent: true })
      await this.pool.query(
        `UPDATE motor_outbox SET status = 'published', published_at = NOW(), attempt = attempt + 1,
                last_error = NULL, updated_at = NOW()
           WHERE message_id = ? AND status = 'pending'`, [message.messageId],
      )
    } catch (error) {
      await this.pool.query(
        `UPDATE motor_outbox SET attempt = attempt + 1, last_error = ?, updated_at = NOW()
           WHERE message_id = ? AND status = 'pending'`,
        [error instanceof Error ? error.message : String(error), message.messageId],
      )
      console.error(`[OutboxPublisher] publicação pendente ${message.messageId}:`, error)
    }
  }
}
