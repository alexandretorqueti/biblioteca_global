import { describe, expect, it, vi } from 'vitest'
import { RealtimeMutationPublisher } from '../src/realtime/RealtimeMutationPublisher.js'

function poolStub() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM tarefas t')) return [[{ task_id: 31, source_task_id: 'task-p2-31', project_id: 7, project_slug: 'gerenteagentes', title: 'Mapa realtime' }]]
      if (sql.includes('SELECT id, seq')) return [[{ id: 44, seq: 2, titulo: 'Emitir eventos', status: 'running' }]]
      if (sql.includes('COUNT(*) AS total')) return [[{ total: 2, pending: 1, running: 1, completed: 0, failed: 0 }]]
      return [[]]
    }),
  }
}

describe('RealtimeMutationPublisher', () => {
  it('mapeia uma alteração de subtarefa para evento e contadores do contrato', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const publisher = new RealtimeMutationPublisher(poolStub() as never, { endpoint: 'http://api/realtime/ingress', token: 'token', fetchImpl })

    await publisher.publishSubtask(31, 44, 'subtask.status.changed', 'pending')

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const event = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(event).toMatchObject({ projectId: 7, taskId: 31, sourceTaskId: 'task-p2-31', subtaskId: 44, type: 'subtask.status.changed', payload: { seq: 2, title: 'Emitir eventos', status: 'running', previousStatus: 'pending' } })
    expect(event.eventId).toEqual(expect.any(String))
    const counters = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))
    expect(counters).toMatchObject({ type: 'task.counters.updated', payload: { total: 2, pending: 1, running: 1 } })
  })

  it('não propaga falha temporária do ingresso para a mutação já confirmada', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('gateway indisponível') })
    const publisher = new RealtimeMutationPublisher(poolStub() as never, { endpoint: 'http://api/realtime/ingress', fetchImpl })
    await expect(publisher.publishTask(31, 'task.updated', { title: 'novo título' })).resolves.toBeUndefined()
  })
})
