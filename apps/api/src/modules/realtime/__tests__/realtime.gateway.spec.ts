// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"
import { RealtimeGateway, type MapSnapshotProvider } from "../realtime.gateway"
import { RealtimeService } from "../realtime.service"

interface MockClient {
  readyState: number
  send: (value: string) => void
  sent: string[]
  closed: boolean
  close: (code?: number, reason?: string) => void
  closeCode?: number
  closeReason?: string
}

function mockClient(): MockClient {
  const sent: string[] = []
  return {
    readyState: 1,
    send: (value: string) => sent.push(value),
    sent,
    closed: false,
    close(code?: number, reason?: string) {
      this.closed = true
      this.closeCode = code
      this.closeReason = reason
    },
  }
}

const mockJwt = {
  verifyAsync: vi.fn(),
}

const mockAuthRepository = {
  resolveScope: vi.fn(),
}

describe("RealtimeGateway — formato de inscrição WsAdapter", () => {
  let gateway: RealtimeGateway
  let service: RealtimeService
  let client: MockClient
  const projectId = 7

  beforeEach(() => {
    service = new RealtimeService()
    gateway = new RealtimeGateway(
      mockJwt as never,
      mockAuthRepository as never,
      service,
    )
    client = mockClient()
    // Simular sessão autenticada (feita via handleConnection)
    ;(gateway as unknown as { sessoes: WeakMap<WebSocket, { projetoId: number }> })
      .sessoes.set(client as unknown as WebSocket, { projetoId: projectId })
  })

  describe("subscribe — canal task", () => {
    it("aceita inscrição no formato WsAdapter (event + data) e responde subscribed", () => {
      // Formato que o RealtimeClient corrigido envia:
      const wsAdapterMessage = {
        type: "subscribe",
        channel: "task",
        taskId: 123,
        lastSequence: undefined,
      }

      gateway.subscribe(client as unknown as WebSocket, wsAdapterMessage)

      expect(client.sent).toHaveLength(1)
      const response = JSON.parse(client.sent[0]!)
      expect(response).toEqual({
        type: "subscribed",
        taskId: 123,
        currentSequence: 0,
      })
    })

    it("aceita inscrição com lastSequence e faz replay quando disponível", () => {
      // Publicar evento primeiro para ter sequence > 0
      service.publicar({
        eventId: "evt-1",
        occurredAt: "2026-10-11T10:00:00.000Z",
        source: "test",
        projectId,
        taskId: 456,
        type: "task.started",
        payload: {},
      })

      const wsAdapterMessage = {
        type: "subscribe",
        channel: "task",
        taskId: 456,
        lastSequence: 0,
      }

      gateway.subscribe(client as unknown as WebSocket, wsAdapterMessage)

      // Deve receber o replay + subscribed
      expect(client.sent.length).toBeGreaterThanOrEqual(1)
      const lastResponse = JSON.parse(client.sent[client.sent.length - 1]!)
      expect(lastResponse.type).toBe("subscribed")
      expect(lastResponse.taskId).toBe(456)
      expect(lastResponse.currentSequence).toBe(1)
    })

    it("rejeita inscrição sem taskId no canal task", () => {
      const invalidMessage = {
        type: "subscribe",
        channel: "task",
        lastSequence: undefined,
      }

      gateway.subscribe(client as unknown as WebSocket, invalidMessage)

      expect(client.sent).toHaveLength(1)
      const response = JSON.parse(client.sent[0]!)
      expect(response.type).toBe("error")
      expect(response.code).toBe("INVALID_SUBSCRIPTION")
    })

    it("rejeita inscrição com taskId inválido (0 ou negativo)", () => {
      const invalidMessage = {
        type: "subscribe",
        channel: "task",
        taskId: 0,
        lastSequence: undefined,
      }

      gateway.subscribe(client as unknown as WebSocket, invalidMessage)

      expect(client.sent).toHaveLength(1)
      const response = JSON.parse(client.sent[0]!)
      expect(response.type).toBe("error")
      expect(response.code).toBe("INVALID_SUBSCRIPTION")
    })
  })

  describe("subscribe — canal map", () => {
    it("aceita inscrição no canal map e responde map_subscribed com snapshot", async () => {
      const mockSnapshotProvider: MapSnapshotProvider = vi.fn().mockResolvedValue({
        projectId,
        tasks: [],
        counters: { total: 0 },
      })
      gateway.setMapSnapshotProvider(mockSnapshotProvider)

      const wsAdapterMessage = {
        type: "subscribe",
        channel: "map",
        lastSequence: undefined,
      }

      gateway.subscribe(client as unknown as WebSocket, wsAdapterMessage)

      // Aguardar processamento assíncrono do snapshot
      await vi.waitFor(() => expect(client.sent.length).toBeGreaterThanOrEqual(1))

      const responses = client.sent.map(s => JSON.parse(s))
      const mapSubscribed = responses.find(r => r.type === "map_subscribed")
      expect(mapSubscribed).toBeDefined()
      expect(mapSubscribed.projectId).toBe(projectId)
      expect(mapSubscribed.currentSequence).toBe(0)

      expect(mockSnapshotProvider).toHaveBeenCalledWith(projectId)
    })

    it("retorna erro quando mapSnapshotProvider não está configurado", async () => {
      gateway.setMapSnapshotProvider(null)

      const wsAdapterMessage = {
        type: "subscribe",
        channel: "map",
        lastSequence: undefined,
      }

      gateway.subscribe(client as unknown as WebSocket, wsAdapterMessage)

      await vi.waitFor(() => expect(client.sent).toHaveLength(1))

      const response = JSON.parse(client.sent[0]!)
      expect(response.type).toBe("error")
      expect(response.code).toBe("MAP_SNAPSHOT_UNAVAILABLE")
    })

    it("inclui map_snapshot antes de map_subscribed quando há dados", async () => {
      const mockSnapshotProvider: MapSnapshotProvider = vi.fn().mockResolvedValue({
        projectId,
        tasks: [
          { taskId: 1, title: "Tarefa 1", status: "running", counters: { total: 0 } },
        ],
        counters: { total: 1 },
      })
      gateway.setMapSnapshotProvider(mockSnapshotProvider)

      const wsAdapterMessage = {
        type: "subscribe",
        channel: "map",
        lastSequence: undefined,
      }

      gateway.subscribe(client as unknown as WebSocket, wsAdapterMessage)

      await vi.waitFor(() => expect(client.sent.length).toBeGreaterThanOrEqual(2))

      const responses = client.sent.map(s => JSON.parse(s))
      const snapshot = responses.find(r => r.type === "map_snapshot")
      const subscribed = responses.find(r => r.type === "map_subscribed")

      expect(snapshot).toBeDefined()
      expect(snapshot.projectId).toBe(projectId)
      expect(snapshot.snapshot.tasks).toHaveLength(1)
      expect(subscribed).toBeDefined()
    })
  })

  describe("subscribe — canal project-feed", () => {
    it("aceita inscrição no canal project-feed e responde feed_subscribed", () => {
      const wsAdapterMessage = {
        type: "subscribe",
        channel: "project-feed",
        lastSequence: undefined,
      }

      gateway.subscribe(client as unknown as WebSocket, wsAdapterMessage)

      expect(client.sent).toHaveLength(1)
      const response = JSON.parse(client.sent[0]!)
      expect(response).toEqual({
        type: "feed_subscribed",
        currentSequence: 0,
      })
    })

    it("faz replay de eventos no feed quando lastSequence é informado", () => {
      // Publicar eventos primeiro
      service.publicar({
        eventId: "feed-evt-1",
        occurredAt: "2026-10-11T10:00:00.000Z",
        source: "test",
        projectId,
        taskId: 1,
        type: "task.updated",
        payload: { title: "Teste" },
      })
      service.publicar({
        eventId: "feed-evt-2",
        occurredAt: "2026-10-11T10:01:00.000Z",
        source: "test",
        projectId,
        taskId: 2,
        type: "task.started",
        payload: {},
      })

      const wsAdapterMessage = {
        type: "subscribe",
        channel: "project-feed",
        lastSequence: 1,
      }

      gateway.subscribe(client as unknown as WebSocket, wsAdapterMessage)

      // Deve receber replay do evento 2 + feed_subscribed
      expect(client.sent.length).toBeGreaterThanOrEqual(1)
      const lastResponse = JSON.parse(client.sent[client.sent.length - 1]!)
      expect(lastResponse.type).toBe("feed_subscribed")
      expect(lastResponse.currentSequence).toBe(2)
    })
  })

  describe("validação de formato", () => {
    it("rejeita mensagem sem campo type", () => {
      const invalidMessage = {
        channel: "task",
        taskId: 123,
      }

      gateway.subscribe(client as unknown as WebSocket, invalidMessage)

      expect(client.sent).toHaveLength(1)
      const response = JSON.parse(client.sent[0]!)
      expect(response.type).toBe("error")
      expect(response.code).toBe("INVALID_SUBSCRIPTION")
    })

    it("rejeita mensagem com type inválido", () => {
      const invalidMessage = {
        type: "invalid_type",
        channel: "task",
        taskId: 123,
      }

      gateway.subscribe(client as unknown as WebSocket, invalidMessage)

      expect(client.sent).toHaveLength(1)
      const response = JSON.parse(client.sent[0]!)
      expect(response.type).toBe("error")
      expect(response.code).toBe("INVALID_SUBSCRIPTION")
    })

    it("rejeita mensagem com canal inválido", () => {
      const invalidMessage = {
        type: "subscribe",
        channel: "invalid_channel",
        taskId: 123,
      }

      gateway.subscribe(client as unknown as WebSocket, invalidMessage)

      expect(client.sent).toHaveLength(1)
      const response = JSON.parse(client.sent[0]!)
      expect(response.type).toBe("error")
      expect(response.code).toBe("INVALID_SUBSCRIPTION")
    })

    it("rejeita subscribe quando sessão não está autenticada", () => {
      const unauthClient = mockClient()
      // Não registrar sessão no WeakMap

      const wsAdapterMessage = {
        type: "subscribe",
        channel: "task",
        taskId: 123,
        lastSequence: undefined,
      }

      gateway.subscribe(unauthClient as unknown as WebSocket, wsAdapterMessage)

      expect(unauthClient.sent).toHaveLength(1)
      const response = JSON.parse(unauthClient.sent[0]!)
      expect(response.type).toBe("error")
      expect(response.code).toBe("INVALID_SUBSCRIPTION")
    })
  })

  describe("ping", () => {
    it("responde pong ao ping", () => {
      gateway.ping(client as unknown as WebSocket)

      expect(client.sent).toHaveLength(1)
      const response = JSON.parse(client.sent[0]!)
      expect(response.type).toBe("pong")
    })
  })

  describe("subscribe — canal helpdesk", () => {
    it("envia snapshot e replay somente para a sessão do usuário/projeto", async () => {
      ;(gateway as unknown as { sessoes: WeakMap<WebSocket, { projetoId: number; usuarioId: number }> })
        .sessoes.set(client as unknown as WebSocket, { projetoId: projectId, usuarioId: 11 })
      gateway.setHelpDeskSnapshotProvider(() => ({
        sessaoId: 91,
        usuarioId: 11,
        projetoId: projectId,
        mensagens: [],
      }))
      service.publicarHelpDesk({ projectId, userId: 11, sessionId: 91, type: "helpdesk.processing.changed", payload: { processing: true, responded: false } })

      await gateway.subscribe(client as unknown as WebSocket, { type: "subscribe", channel: "helpdesk", sessaoId: 91, lastSequence: 0 })

      const responses = client.sent.map((entry) => JSON.parse(entry))
      expect(responses.some((entry) => entry.type === "helpdesk_snapshot")).toBe(true)
      expect(responses.some((entry) => entry.type === "event" && entry.event.type === "helpdesk.processing.changed")).toBe(true)
      expect(responses.at(-1)).toEqual({ type: "helpdesk_subscribed", sessaoId: 91, currentSequence: 1 })
    })

    it("nega sessão de outro usuário ou projeto antes de registrar inscrição", async () => {
      ;(gateway as unknown as { sessoes: WeakMap<WebSocket, { projetoId: number; usuarioId: number }> })
        .sessoes.set(client as unknown as WebSocket, { projetoId: projectId, usuarioId: 11 })
      gateway.setHelpDeskSnapshotProvider(() => ({
        sessaoId: 92,
        usuarioId: 99,
        projetoId: 999,
        mensagens: [],
      }))

      await gateway.subscribe(client as unknown as WebSocket, { type: "subscribe", channel: "helpdesk", sessaoId: 92 })

      expect(JSON.parse(client.sent[0]!)).toEqual({ type: "error", code: "FORBIDDEN_SUBSCRIPTION", message: "Sessão HelpDesk não pertence ao escopo autenticado" })
      service.publicarHelpDesk({ projectId, userId: 11, sessionId: 92, type: "helpdesk.processing.changed", payload: { processing: false, responded: true } })
      expect(client.sent).toHaveLength(1)
    })
  })
})
