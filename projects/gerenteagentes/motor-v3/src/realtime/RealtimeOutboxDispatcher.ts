import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { RealtimeOutboxEvent, RealtimeEventType } from './RealtimeMutationBoundary.js'
import type { WorkerActivityResponse } from '../status/WorkerActivity.js'
import { workerActivitySignature } from '../status/WorkerActivity.js'

interface OutboxRow extends RowDataPacket {
  event_id: string
  task_id: number
  source_task_id: string | null
  project_id: number
  subtask_id: number | null
  type: RealtimeEventType
  previous_status: string | null
  status: string | null
  payload: string | Record<string, unknown>
  per_task_seq: number
  attempts: number
  created_at: Date | string
}

export interface RealtimeOutboxDispatcherConfig {
  publish?: (event: RealtimeOutboxEvent) => Promise<void>
  endpoint?: string
  token?: string
  fetchImpl?: typeof fetch
  intervalMs?: number
  maxAttemptsBeforeAlert?: number
  activityProvider?: () => Promise<WorkerActivityResponse>
  activityProjectId?: number
}

/** Drena eventos depois do commit, sem deixar a indisponibilidade do WS
 * desfazer ou bloquear a mutação que já foi confirmada no banco. */
export class RealtimeOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null
  private flushing = false
  private consecutiveFailures = 0
  private alertEmitted = false
  private readonly fetchImpl: typeof fetch
  private lastActivitySignature: string | null = null

  constructor(private readonly pool: Pool, private readonly config: RealtimeOutboxDispatcherConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.flush() }, this.config.intervalMs ?? 1_000)
    this.timer.unref()
    void this.flush()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      await this.flushActivity()
      const [rows] = await this.pool.query<OutboxRow[]>(
        `SELECT o.event_id, o.task_id, o.source_task_id, o.project_id, o.subtask_id, o.type,
                o.previous_status, o.status, o.payload, o.per_task_seq, o.attempts, o.created_at
           FROM realtime_event_outbox o
          WHERE o.delivery_status IN ('pending', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM realtime_event_outbox earlier
               WHERE earlier.task_id = o.task_id
                 AND earlier.per_task_seq < o.per_task_seq
                 AND earlier.delivery_status <> 'published'
            )
          ORDER BY o.task_id ASC, o.per_task_seq ASC
          LIMIT 100`,
      )
      for (const row of rows) await this.publishRow(row)
    } finally {
      this.flushing = false
    }
  }

  private async flushActivity(): Promise<void> {
    if (!this.config.activityProvider) return
    let snapshot: WorkerActivityResponse
    try { snapshot = await this.config.activityProvider() } catch { return }
    const signature = workerActivitySignature(snapshot)
    if (signature === this.lastActivitySignature) return
    const eventId = randomUUID()
    const projectId = this.config.activityProjectId ?? 640
    // Atividade é uma projeção do motor, não de uma tarefa específica. O
    // task_id zero mantém sua sequência isolada; o envelope usa 1 abaixo por
    // compatibilidade com o contrato compartilhado, que exige taskId positivo.
    await this.pool.query<ResultSetHeader>(
      `INSERT INTO realtime_event_outbox
       (event_id, task_id, source_task_id, project_id, subtask_id, type,
        previous_status, status, payload, per_task_seq, delivery_status, attempts, created_at)
       VALUES (?, 0, 'motor', ?, NULL, 'motor.activity.updated', NULL, NULL, ?,
               (SELECT COALESCE(MAX(seq), 0) + 1 FROM
                 (SELECT per_task_seq AS seq FROM realtime_event_outbox WHERE task_id = 0) AS activity_seq),
               'pending', 0, NOW())`,
      [eventId, projectId, JSON.stringify(snapshot)],
    )
    this.lastActivitySignature = signature
  }

  private async publishRow(row: OutboxRow): Promise<void> {
    const event: RealtimeOutboxEvent = {
      eventId: row.event_id, taskId: Number(row.task_id) || 1, sourceTaskId: row.source_task_id,
      projectId: Number(row.project_id), subtaskId: row.subtask_id == null ? null : Number(row.subtask_id),
      type: row.type, previousStatus: row.previous_status as RealtimeOutboxEvent['previousStatus'],
      status: row.status as RealtimeOutboxEvent['status'],
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) as Record<string, unknown> : row.payload,
      perTaskSeq: Number(row.per_task_seq), createdAt: new Date(row.created_at).toISOString(),
    }
    try {
      if (this.config.publish) {
        await this.config.publish(event)
      } else if (this.config.endpoint) {
        const response = await this.fetchImpl(this.config.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.token ?? ''}`,
            'content-type': 'application/json',
            'idempotency-key': event.eventId,
          },
          body: JSON.stringify({
            eventId: event.eventId, occurredAt: event.createdAt, source: 'gerenteagentes-motor-v3',
            projectId: event.projectId, taskId: event.taskId, sourceTaskId: event.sourceTaskId,
            ...(event.subtaskId == null ? {} : { subtaskId: event.subtaskId }),
            type: event.type,
            payload: { ...event.payload, previousStatus: event.previousStatus, status: event.status,
              perTaskSeq: event.perTaskSeq },
          }),
        })
        if (!response.ok) throw new Error(`Ingresso realtime recusou ${event.eventId}: HTTP ${response.status}`)
      } else {
        throw new Error('Nenhum ingresso realtime configurado para o despachante')
      }
      await this.pool.query<ResultSetHeader>(
        `UPDATE realtime_event_outbox
            SET delivery_status = 'published', published_at = NOW(), attempts = attempts + 1, last_error = NULL
          WHERE event_id = ? AND delivery_status IN ('pending', 'failed')`, [row.event_id],
      )
      this.consecutiveFailures = 0
      this.alertEmitted = false
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.pool.query(
        `UPDATE realtime_event_outbox SET delivery_status = 'failed', attempts = attempts + 1, last_error = ? WHERE event_id = ?`,
        [message, row.event_id],
      )
      this.consecutiveFailures++
      const threshold = this.config.maxAttemptsBeforeAlert ?? 5
      if (this.consecutiveFailures >= threshold && !this.alertEmitted) {
        console.error('[Motor v3] realtime: falha persistente ao publicar outbox; a mutação foi preservada e será reenviada')
        this.alertEmitted = true
      }
    }
  }
}
