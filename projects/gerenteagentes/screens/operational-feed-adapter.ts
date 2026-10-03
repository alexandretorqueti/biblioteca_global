/**
 * Adaptador do quadro inferior do Mapa de agentes.
 *
 * Converte envelopes realtime (canal `project-feed`) no formato agregado do
 * feed operacional (subtarefa 1 — `api/operational-feed.ts`) e faz a mesclagem
 * deduplicada com o snapshot REST. O feed é somente leitura: nada aqui executa
 * ações de negócio.
 */
import type { TaskEventEnvelope } from '@biblioteca-global/shared'
import type {
  OperationalFeedItem,
  OperationalFeedSnapshot,
  OperationalMessageState,
} from '../api/operational-feed'

export const FEED_MAX_ITEMS = 100

const str = (value: unknown): string | null => (value == null ? null : String(value))

function messageState(state: unknown, role: string): OperationalMessageState {
  const raw = String(state ?? '')
  if (raw === 'failed') return 'failed'
  if (raw === 'consumed') return 'consumed'
  if (raw === 'delivered') return 'delivered'
  if (raw === 'pending') return 'pending'
  if (raw === 'deferred' || raw === 'cancelled') return 'deferred'
  return role === 'user' ? 'sent' : 'received'
}

/** Converte um envelope realtime em item do feed, ou null quando não aplicável. */
export function feedItemFromEnvelope(envelope: TaskEventEnvelope): OperationalFeedItem | null {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>
  const base = {
    projectId: envelope.projectId,
    taskId: envelope.taskId,
    taskTitle: str(payload.titulo ?? payload.tituloTarefa),
    agentId: str(payload.agentId ?? envelope.source),
    phase: str(payload.phase),
  }
  const isMessage = envelope.type.includes('chat') || envelope.type.includes('message')
  const texto = typeof payload.texto === 'string' ? payload.texto : typeof payload.text === 'string' ? payload.text : null
  if (isMessage && texto != null) {
    const role = String(payload.role ?? payload.modo ?? 'assistant')
    return {
      id: payload.id != null ? `message:${String(payload.id)}` : `message:${envelope.eventId}`,
      type: 'message', ...base, role,
      state: messageState(payload.estado ?? payload.deliveryState, role),
      text: texto, reason: str(payload.error ?? payload.erro),
      occurredAt: typeof payload.createdAt === 'string' ? payload.createdAt : envelope.occurredAt,
      updatedAt: envelope.occurredAt,
    }
  }
  if (envelope.type.startsWith('action.') || payload.actionType != null) {
    return {
      id: payload.id != null ? `action:${String(payload.id)}` : `action:${envelope.eventId}`,
      type: 'pending_action', ...base,
      actionType: str(payload.actionType) ?? envelope.type,
      description: str(payload.description),
      priority: Number(payload.priority ?? 0),
      state: String(payload.state ?? payload.status ?? 'pending'),
      reason: str(payload.reason ?? payload.lastError),
      occurredAt: typeof payload.occurredAt === 'string' ? payload.occurredAt : envelope.occurredAt,
    }
  }
  return {
    id: payload.id != null ? `event:${String(payload.id)}` : `event:${envelope.eventId}`,
    type: 'event', ...base,
    event: envelope.type,
    description: str(payload.description),
    reason: str(payload.reason ?? payload.motivo),
    payload: envelope.payload as Record<string, unknown> | null,
    occurredAt: envelope.occurredAt,
  }
}

const recency = (item: OperationalFeedItem): number =>
  Date.parse(item.updatedAt ?? item.occurredAt) || Date.parse(item.occurredAt)

/**
 * Mescla um item realtime no estado local do feed:
 * - deduplica por `id` (item novo substitui o antigo se for pelo menos tão recente);
 * - item novo entra no topo e a lista é truncada em FEED_MAX_ITEMS;
 * - itens já conhecidos nunca são substituídos por versão mais antiga.
 */
export function mergeFeedItem(items: OperationalFeedItem[], item: OperationalFeedItem): OperationalFeedItem[] {
  const index = items.findIndex(current => current.id === item.id)
  if (index === -1) {
    return [item, ...items].sort((a, b) => recency(b) - recency(a)).slice(0, FEED_MAX_ITEMS)
  }
  if (recency(item) < recency(items[index])) return items
  const next = items.slice()
  next[index] = { ...items[index], ...item } as OperationalFeedItem
  return next
}

/** Normaliza a resposta REST do snapshot para o estado local do painel. */
export function normalizeFeedSnapshot(snapshot: Partial<OperationalFeedSnapshot> | null | undefined): OperationalFeedItem[] {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : []
  return items
    .filter(item => item && typeof item.id === 'string')
    .sort((a, b) => recency(b) - recency(a))
    .slice(0, FEED_MAX_ITEMS)
}
