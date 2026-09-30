import { Injectable, Inject } from '@nestjs/common'
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from '../../../apps/api/src/modules/crud/project-db.factory'

export const OPERATIONAL_FEED_LIMIT = 100

export type OperationalMessageState = 'sent' | 'received' | 'pending' | 'deferred' | 'delivered' | 'consumed' | 'failed'
export type OperationalFeedItemType = 'message' | 'event' | 'pending_action'

export interface OperationalFeedMessage {
  id: string
  type: 'message'
  projectId: number
  taskId: number
  taskTitle?: string | null
  agentId?: string | null
  phase?: string | null
  state: OperationalMessageState
  role: string
  text: string
  reason?: string | null
  occurredAt: string
  updatedAt?: string
}

export interface OperationalFeedEvent {
  id: string
  type: 'event'
  projectId: number
  taskId: number
  taskTitle?: string | null
  agentId?: string | null
  phase?: string | null
  event: string
  reason?: string | null
  payload?: Record<string, unknown> | null
  occurredAt: string
}

export interface OperationalPendingAction {
  id: string
  type: 'pending_action'
  projectId: number
  taskId: number
  taskTitle?: string | null
  actionType: string
  priority: number
  state: string
  occurredAt: string
  reason?: string | null
}

export type OperationalFeedItem = OperationalFeedMessage | OperationalFeedEvent | OperationalPendingAction

export interface OperationalFeedSnapshot {
  items: OperationalFeedItem[]
  nextCursor: string | null
  hasMore: boolean
  replay: { channel: 'project-feed'; lastSequence: number | null; reloadRequired: boolean }
}

export interface OperationalFeedSources {
  projectId: number
  messages: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
  actions: Array<Record<string, unknown>>
}

const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value ?? 0)).toISOString()
const text = (value: unknown): string | null => value == null ? null : String(value)
const number = (value: unknown): number => Number(value)

function messageState(row: Record<string, unknown>): OperationalMessageState {
  const delivery = String(row.deliveryState ?? '')
  if (delivery === 'failed') return 'failed'
  if (delivery === 'consumed') return 'consumed'
  if (delivery === 'delivered') return 'delivered'
  if (delivery === 'pending' || delivery === 'delivering') return delivery === 'delivering' ? 'sent' : 'pending'
  if (delivery === 'cancelled') return 'deferred'
  return row.role === 'user' ? 'sent' : 'received'
}

export function aggregateOperationalFeed(sources: OperationalFeedSources, limit = OPERATIONAL_FEED_LIMIT): OperationalFeedItem[] {
  const items: OperationalFeedItem[] = []
  for (const row of sources.messages) {
    const taskId = number(row.taskId)
    if (number(row.projectId ?? sources.projectId) !== sources.projectId || !taskId) continue
    items.push({
      id: `message:${row.id}`,
      type: 'message', projectId: sources.projectId, taskId,
      taskTitle: text(row.taskTitle), agentId: text(row.agentId), phase: text(row.phase),
      state: messageState(row), role: String(row.role ?? 'system'), text: String(row.text ?? row.texto ?? ''),
      reason: text(row.deliveryError ?? row.reason), occurredAt: iso(row.createdAt),
      updatedAt: row.updatedAt == null ? undefined : iso(row.updatedAt),
    })
  }
  for (const row of sources.events) {
    const taskId = number(row.taskId)
    if (number(row.projectId ?? sources.projectId) !== sources.projectId || !taskId) continue
    items.push({
      id: `event:${row.id}`, type: 'event', projectId: sources.projectId, taskId,
      taskTitle: text(row.taskTitle), agentId: text(row.agentId), phase: text(row.phase),
      event: String(row.event ?? row.evento ?? 'operational'), reason: text(row.reason ?? row.motivo),
      payload: (row.payload as Record<string, unknown> | null | undefined) ?? null, occurredAt: iso(row.createdAt ?? row.occurredAt),
    })
  }
  for (const row of sources.actions) {
    const taskId = number(row.taskId)
    if (number(row.projectId ?? sources.projectId) !== sources.projectId || !taskId) continue
    items.push({
      id: `action:${row.id}`, type: 'pending_action', projectId: sources.projectId, taskId,
      taskTitle: text(row.taskTitle), actionType: String(row.actionType ?? row.type ?? 'pending'),
      priority: number(row.priority ?? 0), state: String(row.state ?? row.status ?? 'pending'),
      reason: text(row.reason ?? row.lastError), occurredAt: iso(row.occurredAt ?? row.createdAt),
    })
  }
  const unique = new Map<string, OperationalFeedItem>()
  for (const item of items) unique.set(item.id, item)
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : OPERATIONAL_FEED_LIMIT
  return [...unique.values()]
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id))
    .slice(0, safeLimit)
}

@Injectable()
export class OperationalFeedService {
  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
  ) {}

  /** Leitura tenant-scoped: o banco é derivado do projeto autenticado. */
  async snapshot(projectId: number, options: { limit?: number; lastSequence?: number } = {}): Promise<OperationalFeedSnapshot> {
    const db = await this.factory.obter({ id: projectId })
    const [messages] = await db.execute(`SELECT c.id, c.tarefa_id AS taskId, c.role, c.texto AS text, c.created_at AS createdAt,
      e.estado AS deliveryState, e.erro AS deliveryError, e.updated_at AS updatedAt
      FROM tarefa_chats c LEFT JOIN tarefa_chat_entregas e ON e.mensagem_id = c.id
      JOIN tarefas t ON t.id = c.tarefa_id WHERE t.projeto_id IS NOT NULL
      ORDER BY c.created_at DESC, c.id DESC LIMIT 500`)
    const [events] = await db.execute(`SELECT id, tarefa_id AS taskId, evento AS event, payload, created_at AS createdAt
      FROM tarefa_eventos WHERE tarefa_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 500`)
    const [actions] = await db.execute(`SELECT id, CAST(task_id AS UNSIGNED) AS taskId, type AS actionType, 0 AS priority, status AS state,
      last_error AS lastError, created_at AS occurredAt FROM motor_outbox WHERE status = 'pending'
      UNION ALL SELECT message_id AS id, CAST(task_id AS UNSIGNED), message_type, 0, status, error_message, created_at
      FROM motor_message_processing_state WHERE status IN ('pending','processing') ORDER BY occurredAt DESC LIMIT 500`)
    const items = aggregateOperationalFeed({ projectId, messages: messages as unknown as Record<string, unknown>[], events: events as unknown as Record<string, unknown>[], actions: actions as unknown as Record<string, unknown>[] }, options.limit)
    return {
      items, nextCursor: null, hasMore: items.length >= (options.limit ?? OPERATIONAL_FEED_LIMIT),
      replay: { channel: 'project-feed', lastSequence: options.lastSequence ?? null, reloadRequired: false },
    }
  }
}
