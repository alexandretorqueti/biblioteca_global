import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
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
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

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

  it('usa o endpoint padrão com /api/internal/realtime/events quando LIBRARY_REALTIME_EVENTS_URL não está definida', async () => {
    const originalEnv = process.env.LIBRARY_REALTIME_EVENTS_URL
    delete process.env.LIBRARY_REALTIME_EVENTS_URL

    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const publisher = new RealtimeMutationPublisher(poolStub() as never, {
      endpoint: process.env.LIBRARY_REALTIME_EVENTS_URL ?? 'http://localhost:3001/api/internal/realtime/events',
      token: 'test-token',
      fetchImpl,
    })

    await publisher.publishTask(31, 'task.updated', { title: 'teste' })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/internal/realtime/events')

    if (originalEnv !== undefined) {
      process.env.LIBRARY_REALTIME_EVENTS_URL = originalEnv
    }
  })

  it('respeita o override via LIBRARY_REALTIME_EVENTS_URL quando definida', async () => {
    const originalEnv = process.env.LIBRARY_REALTIME_EVENTS_URL
    process.env.LIBRARY_REALTIME_EVENTS_URL = 'http://custom-host:8080/custom/realtime'

    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const publisher = new RealtimeMutationPublisher(poolStub() as never, {
      endpoint: process.env.LIBRARY_REALTIME_EVENTS_URL ?? 'http://localhost:3001/api/internal/realtime/events',
      token: 'test-token',
      fetchImpl,
    })

    await publisher.publishTask(31, 'task.updated', { title: 'teste' })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://custom-host:8080/custom/realtime')

    if (originalEnv !== undefined) {
      process.env.LIBRARY_REALTIME_EVENTS_URL = originalEnv
    } else {
      delete process.env.LIBRARY_REALTIME_EVENTS_URL
    }
  })

  it('registra erro com status HTTP e endpoint quando ingresso recusa (não-OK), sem propagar exceção', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }))
    const publisher = new RealtimeMutationPublisher(poolStub() as never, {
      endpoint: 'http://localhost:3001/api/internal/realtime/events',
      token: 'secret-token',
      fetchImpl,
    })

    await expect(publisher.publishTask(31, 'task.updated', { title: 'teste' })).resolves.toBeUndefined()

    expect(consoleErrorSpy).toHaveBeenCalled()
    const errorMessage = consoleErrorSpy.mock.calls[0]?.[0] as string
    expect(errorMessage).toContain('task.updated')
    expect(errorMessage).toContain('404')
    expect(errorMessage).toContain('http://localhost:3001/api/internal/realtime/events')
    expect(errorMessage).not.toContain('secret-token')
  })

  it('registra erro com tipo do evento e endpoint quando falha de transporte ocorre, sem propagar exceção', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const publisher = new RealtimeMutationPublisher(poolStub() as never, {
      endpoint: 'http://localhost:3001/api/internal/realtime/events',
      token: 'secret-token',
      fetchImpl,
    })

    await expect(publisher.publishTask(31, 'task.status.changed', { status: 'running' })).resolves.toBeUndefined()

    expect(consoleErrorSpy).toHaveBeenCalled()
    const errorMessage = consoleErrorSpy.mock.calls[0]?.[0] as string
    expect(errorMessage).toContain('task.status.changed')
    expect(errorMessage).toContain('http://localhost:3001/api/internal/realtime/events')
    expect(errorMessage).toContain('ECONNREFUSED')
    expect(errorMessage).not.toContain('secret-token')
  })

  it('emite alerta persistente após 5 falhas consecutivas', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
    const publisher = new RealtimeMutationPublisher(poolStub() as never, {
      endpoint: 'http://localhost:3001/api/internal/realtime/events',
      token: 'token',
      fetchImpl,
    })

    for (let i = 0; i < 5; i++) {
      await publisher.publishTask(31, 'task.updated', { title: `teste-${i}` })
    }

    const persistentAlertCalls = consoleErrorSpy.mock.calls.filter(
      call => String(call[0]).includes('ingresso realtime inalcançável de forma persistente')
    )
    expect(persistentAlertCalls).toHaveLength(1)
    expect(persistentAlertCalls[0]?.[0]).toContain('atualizações do Mapa de Agentes NÃO estão chegando ao front')
  })

  it('não repete o alerta persistente em falhas subsequentes da mesma sequência', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
    const publisher = new RealtimeMutationPublisher(poolStub() as never, {
      endpoint: 'http://localhost:3001/api/internal/realtime/events',
      token: 'token',
      fetchImpl,
    })

    for (let i = 0; i < 10; i++) {
      await publisher.publishTask(31, 'task.updated', { title: `teste-${i}` })
    }

    const persistentAlertCalls = consoleErrorSpy.mock.calls.filter(
      call => String(call[0]).includes('ingresso realtime inalcançável de forma persistente')
    )
    expect(persistentAlertCalls).toHaveLength(1)
  })

  it('reseta contador de falhas após resposta 2xx e permite novo alerta se nova sequência atingir o limiar', async () => {
    let callCount = 0
    const fetchImpl = vi.fn(async () => {
      callCount++
      // Primeiras 5 chamadas: falha
      if (callCount <= 5) return new Response(null, { status: 500 })
      // Chamada 6: sucesso (reseta contador)
      if (callCount === 6) return new Response(null, { status: 204 })
      // Chamadas 7-11: falha novamente (nova sequência)
      return new Response(null, { status: 500 })
    })

    const publisher = new RealtimeMutationPublisher(poolStub() as never, {
      endpoint: 'http://localhost:3001/api/internal/realtime/events',
      token: 'token',
      fetchImpl,
    })

    // 5 falhas consecutivas → primeiro alerta persistente
    for (let i = 0; i < 5; i++) {
      await publisher.publishTask(31, 'task.updated', { title: `teste-${i}` })
    }

    let persistentAlertCalls = consoleErrorSpy.mock.calls.filter(
      call => String(call[0]).includes('ingresso realtime inalcançável de forma persistente')
    )
    expect(persistentAlertCalls).toHaveLength(1)

    // 1 sucesso → reseta contador
    await publisher.publishTask(31, 'task.updated', { title: 'sucesso' })

    // 5 novas falhas → segundo alerta persistente
    for (let i = 0; i < 5; i++) {
      await publisher.publishTask(31, 'task.updated', { title: `teste-novo-${i}` })
    }

    persistentAlertCalls = consoleErrorSpy.mock.calls.filter(
      call => String(call[0]).includes('ingresso realtime inalcançável de forma persistente')
    )
    expect(persistentAlertCalls).toHaveLength(2)
  })
})
