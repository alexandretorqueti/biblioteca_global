// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { aggregateOperationalFeed } from '../operational-feed'

const base = { projectId: 10 }

describe('feed operacional agregado', () => {
  it('agrega estados de entrega e mantém ações pendentes separadas', () => {
    const items = aggregateOperationalFeed({
      ...base,
      messages: [
        { id: 1, projectId: 10, taskId: 2, role: 'user', text: 'envio', deliveryState: 'delivered', createdAt: '2026-09-29T10:00:00Z' },
        { id: 2, projectId: 10, taskId: 2, role: 'assistant', text: 'retorno', deliveryState: 'failed', deliveryError: 'timeout', createdAt: '2026-09-29T10:01:00Z' },
        { id: 3, projectId: 10, taskId: 3, role: 'user', text: 'aguardando', deliveryState: 'pending', createdAt: '2026-09-29T10:02:00Z' },
      ],
      events: [{ id: 4, projectId: 10, taskId: 2, event: 'task.blocked', motivo: 'aguardando recurso', createdAt: '2026-09-29T10:03:00Z' }],
      actions: [{ id: 5, projectId: 10, taskId: 3, actionType: 'deploy', priority: 9, state: 'pending', createdAt: '2026-09-29T10:04:00Z' }],
    })
    expect(items.map(item => item.type)).toEqual(['pending_action', 'event', 'message', 'message', 'message'])
    expect(items.find(item => item.id === 'message:2')).toMatchObject({ state: 'failed', reason: 'timeout' })
    expect(items.find(item => item.id === 'action:5')).toMatchObject({ type: 'pending_action', priority: 9, state: 'pending' })
  })

  it('deduplica por identificador e ordena por recência com limite', () => {
    const items = aggregateOperationalFeed({
      ...base,
      messages: [
        { id: 1, taskId: 1, role: 'user', text: 'antiga', createdAt: '2026-09-29T09:00:00Z' },
        { id: 1, taskId: 1, role: 'user', text: 'mesma mensagem', createdAt: '2026-09-29T09:00:00Z' },
        { id: 2, taskId: 1, role: 'user', text: 'nova', createdAt: '2026-09-29T11:00:00Z' },
      ], events: [], actions: [],
    }, 2)
    expect(items).toHaveLength(2)
    expect(items.map(item => item.id)).toEqual(['message:2', 'message:1'])
  })

  it('isola itens de outro projeto', () => {
    const items = aggregateOperationalFeed({
      ...base,
      messages: [{ id: 1, projectId: 99, taskId: 9, role: 'user', text: 'vazamento', createdAt: '2026-09-29T10:00:00Z' }],
      events: [], actions: [],
    })
    expect(items).toEqual([])
  })
})
