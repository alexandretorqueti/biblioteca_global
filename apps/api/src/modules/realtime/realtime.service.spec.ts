// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RealtimeService } from './realtime.service'

interface MockClient {
  readyState: number
  send: (value: string) => void
  sent: string[]
}

function client(): MockClient {
  const sent: string[] = []
  return { readyState: 1, send: (value: string) => sent.push(value), sent }
}

describe('RealtimeService — feed agregado por projeto', () => {
  it('não retransmite o mesmo eventId e mantém a sequência monotônica', () => {
    const service = new RealtimeService()
    const subscribed = client()
    service.inscreverFeed(7, subscribed as never)
    const input = { eventId: 'event-duplicate', occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.updated', payload: { title: 'A' } }
    const first = service.publicar(input)
    const second = service.publicar({ ...input, payload: { title: 'B' } })
    expect(second).toEqual(first)
    expect(subscribed.sent).toHaveLength(1)
    expect(service.inscreverFeed(7, client() as never, 1)).toEqual({ currentSequence: 1, replayAvailable: true })
  })

  it('entrega eventos de tarefas diferentes no canal do projeto e faz replay', () => {
    const service = new RealtimeService()
    const first = client()
    const result = service.inscreverFeed(7, first as never)
    expect(result).toEqual({ currentSequence: 0, replayAvailable: true })
    service.publicar({ eventId: 'event-1', occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.started', payload: {} })
    service.publicar({ eventId: 'event-2', occurredAt: '2026-09-29T10:01:00.000Z', source: 'test', projectId: 7, taskId: 2, type: 'task.error', payload: { message: 'falha' } })
    expect(first.sent).toHaveLength(2)
    expect(JSON.parse(first.sent[1]!).event.taskId).toBe(2)

    const replayClient = client()
    expect(service.inscreverFeed(7, replayClient as never, 1)).toEqual({ currentSequence: 2, replayAvailable: true })
    expect(replayClient.sent).toHaveLength(1)
    expect(JSON.parse(replayClient.sent[0]!).event.eventId).toBe('event-2')
  })

  it('sinaliza replay indisponível quando o cursor ficou fora do buffer', () => {
    const service = new RealtimeService()
    for (let i = 0; i < 5002; i += 1) {
      service.publicar({ eventId: `event-${i}`, occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.started', payload: {} })
    }
    expect(service.inscreverFeed(7, client() as never, 1)).toEqual({ currentSequence: 5002, replayAvailable: false })
  })
})

describe('RealtimeService — canal do mapa', () => {
  it('envia snapshot inicial ao inscrever no mapa', () => {
    const service = new RealtimeService()
    const client1 = client()
    const snapshot = { projectId: 7, tasks: [{ taskId: 1, status: 'running' }], counters: { total: 1 } }
    const result = service.inscreverMapa(7, client1 as never, snapshot)
    expect(result).toEqual({ currentSequence: 0, replayAvailable: true })
    expect(client1.sent).toHaveLength(1)
    const msg = JSON.parse(client1.sent[0]!)
    expect(msg.type).toBe('map_snapshot')
    expect(msg.projectId).toBe(7)
    expect(msg.snapshot).toEqual(snapshot)
  })

  it('replay de eventos após snapshot quando lastSequence é fornecido', () => {
    const service = new RealtimeService()
    service.publicar({ eventId: 'event-1', occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.started', payload: {} })
    service.publicar({ eventId: 'event-2', occurredAt: '2026-09-29T10:01:00.000Z', source: 'test', projectId: 7, taskId: 2, type: 'task.updated', payload: {} })
    const client1 = client()
    const snapshot = { projectId: 7, tasks: [], counters: { total: 0 } }
    const result = service.inscreverMapa(7, client1 as never, snapshot, 1)
    expect(result).toEqual({ currentSequence: 2, replayAvailable: true })
    expect(client1.sent).toHaveLength(2) // snapshot + 1 evento (event-2)
    expect(JSON.parse(client1.sent[0]!).type).toBe('map_snapshot')
    expect(JSON.parse(client1.sent[1]!).event.eventId).toBe('event-2')
  })

  it('sinaliza replay indisponível no mapa quando cursor está fora do buffer', () => {
    const service = new RealtimeService()
    for (let i = 0; i < 5002; i += 1) {
      service.publicar({ eventId: `event-${i}`, occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.started', payload: {} })
    }
    const client1 = client()
    const snapshot = { projectId: 7, tasks: [], counters: { total: 0 } }
    const result = service.inscreverMapa(7, client1 as never, snapshot, 1)
    expect(result).toEqual({ currentSequence: 5002, replayAvailable: false })
    expect(client1.sent).toHaveLength(1) // apenas snapshot
  })

  it('remove cliente de todos os canais ao desconectar', () => {
    const service = new RealtimeService()
    const client1 = client()
    service.inscrever(1, 7, client1 as never)
    service.inscreverFeed(7, client1 as never)
    service.inscreverMapa(7, client1 as never, { projectId: 7, tasks: [], counters: { total: 0 } })
    service.remover(client1 as never)
    // Após remover, novos clientes não devem receber eventos antigos
    const client2 = client()
    service.inscreverFeed(7, client2 as never)
    service.publicar({ eventId: 'event-new', occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.started', payload: {} })
    expect(client2.sent).toHaveLength(1)
  })

  it('broadcast de eventos para inscritos no mapa quando publicar', () => {
    const service = new RealtimeService()
    const mapClient = client()
    const snapshot = { projectId: 7, tasks: [], counters: { total: 0 } }
    service.inscreverMapa(7, mapClient as never, snapshot)
    // Publicar evento deve enviar para o cliente do mapa
    service.publicar({ eventId: 'event-map-1', occurredAt: '2026-09-29T10:00:00.000Z', source: 'test', projectId: 7, taskId: 1, type: 'task.created', payload: { titulo: 'Nova tarefa' } })
    // mapClient deve receber snapshot + evento
    expect(mapClient.sent).toHaveLength(2)
    expect(JSON.parse(mapClient.sent[0]!).type).toBe('map_snapshot')
    expect(JSON.parse(mapClient.sent[1]!).type).toBe('event')
    expect(JSON.parse(mapClient.sent[1]!).event.type).toBe('task.created')
  })
})

describe('RealtimeService — canal notifications (push por usuário)', () => {
  it('publica notification.created somente para o (projetoId, usuarioId) informado', () => {
    const service = new RealtimeService()
    const userA = client()
    const userB = client()
    const otherProject = client()
    service.inscreverNotificacoes(7, 11, userA as never)
    service.inscreverNotificacoes(7, 12, userB as never)
    service.inscreverNotificacoes(8, 11, otherProject as never)

    service.publicarNotificacoes({ projectId: 7, usuarioId: 11, type: 'notification.created', payload: { notification: { id: 10 } } })

    expect(userA.sent).toHaveLength(1)
    expect(userB.sent).toHaveLength(0)
    expect(otherProject.sent).toHaveLength(0)
    const message = JSON.parse(userA.sent[0]!)
    expect(message).toMatchObject({ type: 'notification.created', notification: { id: 10 }, sequence: 1 })
  })

  it('entrega notifications.unread.changed com unreadCount e mantém sequência monotônica por usuário', () => {
    const service = new RealtimeService()
    const user = client()
    service.inscreverNotificacoes(7, 11, user as never)
    service.publicarNotificacoes({ projectId: 7, usuarioId: 11, type: 'notification.created', payload: { notification: { id: 1 } } })
    service.publicarNotificacoes({ projectId: 7, usuarioId: 11, type: 'notifications.unread.changed', payload: { unreadCount: 2 } })

    expect(user.sent).toHaveLength(2)
    expect(JSON.parse(user.sent[0]!)).toMatchObject({ type: 'notification.created', sequence: 1 })
    expect(JSON.parse(user.sent[1]!)).toMatchObject({ type: 'notifications.unread.changed', unreadCount: 2, sequence: 2 })
  })

  it('faz replay acima de lastSequence e sinaliza indisponível para cursor fora do buffer', () => {
    const service = new RealtimeService()
    service.publicarNotificacoes({ projectId: 7, usuarioId: 11, type: 'notification.created', payload: { notification: { id: 1 } } })
    service.publicarNotificacoes({ projectId: 7, usuarioId: 11, type: 'notification.created', payload: { notification: { id: 2 } } })

    const late = client()
    const result = service.inscreverNotificacoes(7, 11, late as never, 1)
    expect(result).toEqual({ currentSequence: 2, replayAvailable: true })
    expect(late.sent).toHaveLength(1)
    expect(JSON.parse(late.sent[0]!).notification).toEqual({ id: 2 })

    // Estoura o buffer (limite 500) e um cursor antigo fica indisponível.
    for (let i = 0; i < 502; i += 1) {
      service.publicarNotificacoes({ projectId: 7, usuarioId: 11, type: 'notification.created', payload: { notification: { id: 100 + i } } })
    }
    const stale = client()
    expect(service.inscreverNotificacoes(7, 11, stale as never, 1)).toEqual({ currentSequence: 504, replayAvailable: false })
    expect(stale.sent).toHaveLength(0)
  })

  it('remove o cliente do canal de notificações ao desconectar', () => {
    const service = new RealtimeService()
    const user = client()
    service.inscreverNotificacoes(7, 11, user as never)
    service.remover(user as never)

    service.publicarNotificacoes({ projectId: 7, usuarioId: 11, type: 'notification.created', payload: { notification: { id: 9 } } })
    expect(user.sent).toHaveLength(0)
  })
})
