import { describe, expect, it, vi } from 'vitest'
import { LibraryRealtimeBroadcaster } from '../src/events/LibraryRealtimeBroadcaster.js'
import type { Db } from '../src/shared/types/infrastructure.js'

function dbWith(rows: Record<string, unknown>[]): Db {
  return {
    query: vi.fn().mockResolvedValue({ rows, affectedRows: 0, insertId: 0 }),
    transaction: vi.fn(),
  }
}

const event = {
  type: 'model_unavailable' as const,
  executionId: 'exec-1',
  taskId: 'task-123',
  subtaskId: 9,
  phase: 'execute' as const,
  level: 'warn' as const,
  model: 'provider/model-a',
  message: 'Modelo indisponível',
  timestamp: new Date('2026-08-29T14:00:00.000Z'),
}

describe('LibraryRealtimeBroadcaster', () => {
  it('resolve os IDs internos e publica o envelope no RealtimeGateway', async () => {
    const db = dbWith([{ task_id: 123, project_id: 7, project_slug: 'gerenteagentes' }])
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201 })
    const broadcaster = new LibraryRealtimeBroadcaster({
      db, endpoint: 'http://api/internal/realtime/events', token: 'secret', fetchImpl,
    })

    await broadcaster.publish(event)

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('t.external_id = ?'), ['task-123'])
    const [, request] = fetchImpl.mock.calls[0]!
    const body = JSON.parse(String(request.body))
    expect(body).toMatchObject({
      projectId: 7, taskId: 123, sourceTaskId: 'task-123', sourceProjectSlug: 'gerenteagentes',
      subtaskId: 9, type: 'model_unavailable',
      payload: { executionId: 'exec-1', phase: 'execute', model: 'provider/model-a' },
    })
    expect(request.headers.authorization).toBe('Bearer secret')
    expect(request.headers['idempotency-key']).toBe(body.eventId)
  })

  it('não publica quando o mapeamento não existe', async () => {
    const fetchImpl = vi.fn()
    const broadcaster = new LibraryRealtimeBroadcaster({
      db: dbWith([]), endpoint: 'http://api/internal/realtime/events', token: 'secret', fetchImpl,
    })

    await expect(broadcaster.publish(event)).rejects.toThrow('Mapeamento realtime não encontrado')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sinaliza recusa do endpoint realtime', async () => {
    const broadcaster = new LibraryRealtimeBroadcaster({
      db: dbWith([{ task_id: 123, project_id: 7, project_slug: 'gerenteagentes' }]),
      endpoint: 'http://api/internal/realtime/events', token: 'secret',
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    })

    await expect(broadcaster.publish(event)).rejects.toThrow('RealtimeGateway recusou evento (401)')
  })
})
