import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { DerivedTaskStatusResolver, type DerivedTaskStatus } from '../status/DerivedTaskStatus.js'
import type { SqlQueryable } from '../status/DerivedTaskStatus.js'

export type RealtimeEventType =
  | 'task.status.changed' | 'task.counters.updated'
  | 'task.created' | 'task.updated' | 'task.deleted'
  | 'subtask.created' | 'subtask.updated' | 'subtask.deleted' | 'subtask.status.changed'

export interface RealtimeOutboxEvent {
  eventId: string
  taskId: number
  sourceTaskId: string | null
  projectId: number
  subtaskId: number | null
  type: RealtimeEventType
  previousStatus: DerivedTaskStatus | null
  status: DerivedTaskStatus | null
  payload: Record<string, unknown>
  perTaskSeq: number
  createdAt: string
}

export interface RealtimeMutationContext {
  connection: PoolConnection
  taskId: number
  before: DerivedTaskStatus
  after: DerivedTaskStatus
  enqueue: (event: Omit<RealtimeOutboxEvent, 'eventId' | 'perTaskSeq' | 'createdAt'>) => Promise<void>
}

export interface RealtimeMutation {
  apply: (context: RealtimeMutationContext) => Promise<void>
  /** Dados adicionais do evento; contadores são sempre gravados no outbox. */
  counters?: Record<string, number>
  subtaskId?: number
}

interface TaskIdentity extends RowDataPacket {
  id: number
  external_id: string | null
  projeto_id: number
}

/**
 * Fronteira única para mutações operacionais. O callback recebe a mesma
 * conexão transacional: fato canônico e outbox nunca podem fazer commits
 * separados. Nenhuma publicação de rede acontece antes do commit.
 */
export class RealtimeMutationBoundary {
  private readonly resolver: DerivedTaskStatusResolver

  constructor(private readonly pool: Pool, resolver?: DerivedTaskStatusResolver) {
    this.resolver = resolver ?? new DerivedTaskStatusResolver(pool)
  }

  async executar(taskId: string | number, mutation: RealtimeMutation): Promise<RealtimeOutboxEvent[]> {
    const connection = await this.pool.getConnection()
    const queued: RealtimeOutboxEvent[] = []
    try {
      await connection.beginTransaction()
      const identity = await this.lockTask(connection, taskId)
      if (!identity) throw new Error(`Tarefa ${taskId} não encontrada para mutação realtime`)

      const before = await new DerivedTaskStatusResolver(connection).resolve(String(identity.external_id ?? identity.id))
      const context: RealtimeMutationContext = {
        connection, taskId: identity.id, before, after: before,
        enqueue: async event => {
          const queuedEvent = await this.insertEvent(connection, identity, event)
          queued.push(queuedEvent)
        },
      }
      await mutation.apply(context)
      context.after = await new DerivedTaskStatusResolver(connection).resolve(String(identity.external_id ?? identity.id))

      if (context.after !== before) {
        await context.enqueue({
          taskId: identity.id, sourceTaskId: identity.external_id, projectId: identity.projeto_id,
          subtaskId: mutation.subtaskId ?? null, type: 'task.status.changed',
          previousStatus: before, status: context.after,
          payload: { previousStatus: before, status: context.after },
        })
      }
      const counters: Record<string, number> | undefined = mutation.counters
        ?? (context.after !== before ? await this.readCounters(connection, identity.id) : undefined)
      if (counters) {
        await context.enqueue({
          taskId: identity.id, sourceTaskId: identity.external_id, projectId: identity.projeto_id,
          subtaskId: mutation.subtaskId ?? null, type: 'task.counters.updated',
          previousStatus: null, status: context.after, payload: { ...counters },
        })
      }
      await connection.commit()
      return queued
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async readCounters(connection: PoolConnection, taskId: number): Promise<Record<string, number>> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total,
          COALESCE(SUM(status = 'pending'), 0) AS pending,
          COALESCE(SUM(status IN ('running', 'delivered', 'verifying')), 0) AS running,
          COALESCE(SUM(status IN ('verified', 'superseded')), 0) AS completed,
          COALESCE(SUM(status IN ('failed', 'blocked')), 0) AS failed
         FROM subtarefas WHERE tarefa_id = ?`, [taskId],
    )
    const row = (rows[0] ?? {}) as Record<string, unknown>
    return Object.fromEntries(['total', 'pending', 'running', 'completed', 'failed']
      .map(key => [key, Number(row[key] ?? 0)]))
  }

  private async lockTask(connection: PoolConnection, taskId: string | number): Promise<TaskIdentity | null> {
    const [rows] = await connection.query<TaskIdentity[]>(
      `SELECT id, external_id, projeto_id FROM tarefas
       WHERE external_id = ? OR CAST(id AS CHAR) = ? LIMIT 1 FOR UPDATE`, [taskId, taskId],
    )
    return rows[0] ?? null
  }

  private async insertEvent(
    connection: PoolConnection,
    identity: TaskIdentity,
    event: Omit<RealtimeOutboxEvent, 'eventId' | 'perTaskSeq' | 'createdAt'>,
  ): Promise<RealtimeOutboxEvent> {
    const [sequenceRows] = await connection.query<RowDataPacket[]>(
      'SELECT COALESCE(MAX(per_task_seq), 0) + 1 AS next_seq FROM realtime_event_outbox WHERE task_id = ? FOR UPDATE',
      [identity.id],
    )
    const perTaskSeq = Number(sequenceRows[0]?.next_seq ?? 1)
    const eventId = randomUUID()
    const createdAt = new Date().toISOString()
    await connection.query<ResultSetHeader>(
      `INSERT INTO realtime_event_outbox
       (event_id, task_id, source_task_id, project_id, subtask_id, type, previous_status, status,
        payload, per_task_seq, delivery_status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NOW())`,
      [eventId, event.taskId, event.sourceTaskId, event.projectId, event.subtaskId, event.type,
        event.previousStatus, event.status, JSON.stringify(event.payload), perTaskSeq],
    )
    return { ...event, eventId, perTaskSeq, createdAt }
  }
}

export type RealtimeMutationQueryable = Pool | PoolConnection | SqlQueryable
