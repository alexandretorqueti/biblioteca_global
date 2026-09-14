// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { WebSocket } from "ws"
import { RealtimeService } from "../realtime.service"

class FakeWebSocket {
  readyState = 1
  sent: string[] = []

  send(message: string): void {
    this.sent.push(message)
  }
}

function evento(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "event-1",
    occurredAt: "2026-09-14T12:00:00.000Z",
    source: "gerenteagentes-motor-v2",
    projectId: 7,
    taskId: 42,
    type: "task.status.changed",
    payload: { status: "running" },
    ...overrides,
  }
}

function mensagens(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>)
}

describe("RealtimeService", () => {
  it("rejeita evento inválido e não o distribui", () => {
    const service = new RealtimeService()
    const socket = new FakeWebSocket()
    service.inscrever(42, 7, socket as unknown as WebSocket)

    expect(() => service.publicar({ eventId: "invalido" })).toThrow("Evento realtime inválido")
    expect(socket.sent).toHaveLength(0)
  })

  it("sequencia e entrega eventos somente no projeto e tarefa inscritos", () => {
    const service = new RealtimeService()
    const mesmoEscopo = new FakeWebSocket()
    const outraTarefa = new FakeWebSocket()
    const outroProjeto = new FakeWebSocket()
    service.inscrever(42, 7, mesmoEscopo as unknown as WebSocket)
    service.inscrever(43, 7, outraTarefa as unknown as WebSocket)
    service.inscrever(42, 8, outroProjeto as unknown as WebSocket)

    const primeiro = service.publicar(evento())
    const segundo = service.publicar(evento({ eventId: "event-2", type: "task.started" }))

    expect(primeiro.sequence).toBe(1)
    expect(segundo.sequence).toBe(2)
    expect(mensagens(mesmoEscopo)).toHaveLength(2)
    expect(outraTarefa.sent).toHaveLength(0)
    expect(outroProjeto.sent).toHaveLength(0)
  })

  it("faz replay dos eventos posteriores à última sequência", () => {
    const service = new RealtimeService()
    service.publicar(evento())
    service.publicar(evento({ eventId: "event-2", type: "task.error" }))
    const socket = new FakeWebSocket()

    const result = service.inscrever(42, 7, socket as unknown as WebSocket, 1)

    expect(result).toEqual({ currentSequence: 2, replayAvailable: true })
    expect(mensagens(socket)).toHaveLength(1)
    expect((mensagens(socket)[0]?.event as Record<string, unknown>).eventId).toBe("event-2")
  })

  it("informa replay indisponível quando o evento saiu do buffer", () => {
    const service = new RealtimeService()
    for (let index = 0; index < 501; index += 1) {
      service.publicar(evento({ eventId: `event-${index}` }))
    }
    const socket = new FakeWebSocket()

    const result = service.inscrever(42, 7, socket as unknown as WebSocket, 0)

    expect(result).toEqual({ currentSequence: 501, replayAvailable: false })
    expect(socket.sent).toHaveLength(0)
  })

  it("não incrementa sequência nem redistribui eventId duplicado", () => {
    const service = new RealtimeService()
    const socket = new FakeWebSocket()
    service.inscrever(42, 7, socket as unknown as WebSocket)

    const primeiro = service.publicar(evento())
    const duplicado = service.publicar(evento({ payload: { status: "completed" } }))

    expect(duplicado).toEqual(primeiro)
    expect(duplicado.sequence).toBe(1)
    expect(socket.sent).toHaveLength(1)
  })

  it("aceitaUmaVez é idempotente para a ingestão", () => {
    const service = new RealtimeService()

    expect(service.aceitarUmaVez("event-1")).toBe(true)
    expect(service.aceitarUmaVez("event-1")).toBe(false)
    expect(service.aceitarUmaVez("event-2")).toBe(true)
  })

  it("remove o cliente de todos os canais inscritos", () => {
    const service = new RealtimeService()
    const socket = new FakeWebSocket()
    service.inscrever(42, 7, socket as unknown as WebSocket)
    service.inscrever(43, 7, socket as unknown as WebSocket)

    service.remover(socket as unknown as WebSocket)
    service.publicar(evento())
    service.publicar(evento({ eventId: "event-2", taskId: 43 }))

    expect(socket.sent).toHaveLength(0)
  })
})
