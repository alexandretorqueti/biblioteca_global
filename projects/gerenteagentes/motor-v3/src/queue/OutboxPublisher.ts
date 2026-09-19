import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from './QueueMessage.js'
import type { QueueTransport } from './QueueTransport.js'

interface OutboxRow extends RowDataPacket {
  message_id: string
  type: string
  task_id: string
  execution_id: string
  payload_json: string | Record<string, unknown>
  timestamp: Date | string
  correlation_id: string | null
  causation_id: string | null
  attempt: number
}

/** Publica mensagens persistidas sem polling periódico. */
export class OutboxPublisher {
  private started = false
  private flushing = false

  constructor(
    private readonly pool: Pool,
    private readonly transport: QueueTransport,
    private readonly queue: string,
  ) {}

  async start(): Promise<void> {
    await this.transport.connect()
    this.started = true
    await this.flush()
  }

  async enqueue(message: QueueMessage): Promise<void> {
    await this.pool.query<ResultSetHeader>(
      `INSERT INTO motor_outbox
        (message_id, type, task_id, execution_id, payload_json, timestamp, correlation_id, causation_id, status, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
       ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)`,
      [message.messageId, message.type, message.taskId, message.executionId,
        JSON.stringify(message.payload), message.timestamp, message.correlationId ?? null,
        message.causationId ?? null],
    )
    if (this.started) await this.flush()
  }

  async flush(): Promise<void> {
    if (!this.started || this.flushing) return
    this.flushing = true
    try {
      const [rows] = await this.pool.query<OutboxRow[]>(
        `SELECT message_id, type, task_id, execution_id, payload_json, timestamp,
                correlation_id, causation_id, attempt
           FROM motor_outbox WHERE status = 'pending' ORDER BY id ASC LIMIT 100`,
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
      await this.transport.publish(this.queue, message, { messageId: message.messageId, persistent: true })
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
