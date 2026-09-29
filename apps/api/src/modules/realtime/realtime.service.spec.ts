// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RealtimeService } from './realtime.service'

function client() {
  const sent: string[] = []
  return { readyState: 1, send: (value: string) => sent.push(value), sent } as never
}

describe('RealtimeService — feed agregado por projeto', () => {
  it('entrega eventos de tarefas diferentes no canal do projeto e faz replay', () => {
    const service = new RealtimeService()
    const first = client()
    const result = service.inscreverFeed(7, first)
    expect(result).toEqual({ currentSequence: 0, replayAvailable: true })
    service.publicar({ eventId: 'event-1', occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.started', payload: {} })
    service.publicar({ eventId: 'event-2', occurredAt: '2026-09-29T10:01:00.000Z', source: 'test', projectId: 7, taskId: 2, type: 'task.error', payload: { message: 'falha' } })
    expect(first.sent).toHaveLength(2)
    expect(JSON.parse(first.sent[1]!).event.taskId).toBe(2)

    const replayClient = client()
    expect(service.inscreverFeed(7, replayClient, 1)).toEqual({ currentSequence: 2, replayAvailable: true })
    expect(replayClient.sent).toHaveLength(1)
    expect(JSON.parse(replayClient.sent[0]!).event.eventId).toBe('event-2')
  })

  it('sinaliza replay indisponível quando o cursor ficou fora do buffer', () => {
    const service = new RealtimeService()
    for (let i = 0; i < 5002; i += 1) {
      service.publicar({ eventId: `event-${i}`, occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.started', payload: {} })
    }
    expect(service.inscreverFeed(7, client(), 1)).toEqual({ currentSequence: 5002, replayAvailable: false })
  })
})
