// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { RealtimeGateway } from "../realtime.gateway"
import type { AuthRepository } from "../../auth/auth.repository"
import type { RealtimeService } from "../realtime.service"
import type { JwtService } from "@nestjs/jwt"
import type { WebSocket } from "ws"

class FakeWebSocket {
  readyState = 1
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null

  send(message: string): void {
    this.sent.push(message)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
}

function messages(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>)
}

function createGateway(replayAvailable = true) {
  const jwt = { verifyAsync: vi.fn().mockResolvedValue({ sub: 42, projetoId: 7, kind: "ws-ticket" }) } as unknown as JwtService
  const authRepository = { resolveScope: vi.fn().mockResolvedValue({ projetoId: 7 }) } as unknown as AuthRepository
  const realtime = {
    inscrever: vi.fn().mockReturnValue({ currentSequence: 2, replayAvailable }),
    remover: vi.fn(),
  } as unknown as RealtimeService
  return { gateway: new RealtimeGateway(jwt, authRepository, realtime), jwt, authRepository, realtime }
}

const request = { url: "/api/realtime/ws?ticket=ticket-1", headers: {} }

describe("RealtimeGateway", () => {
  it("autentica ticket, inscreve no projeto da sessão e confirma", async () => {
    const { gateway, realtime } = createGateway()
    const socket = new FakeWebSocket()

    await gateway.handleConnection(socket as unknown as WebSocket, request)
    gateway.subscribe(socket as unknown as WebSocket, { type: "subscribe", channel: "task", taskId: 42, lastSequence: 1 })

    expect(realtime.inscrever).toHaveBeenCalledWith(42, 7, socket, 1)
    expect(messages(socket)).toEqual([{ type: "subscribed", taskId: 42, currentSequence: 2 }])
  })

  it("responde erro contratual para inscrição inválida", async () => {
    const { gateway, realtime } = createGateway()
    const socket = new FakeWebSocket()
    await gateway.handleConnection(socket as unknown as WebSocket, request)

    gateway.subscribe(socket as unknown as WebSocket, { type: "subscribe", channel: "other", taskId: 42 })

    expect(realtime.inscrever).not.toHaveBeenCalled()
    expect(messages(socket)).toEqual([{ type: "error", code: "INVALID_SUBSCRIPTION", message: "Inscrição inválida" }])
  })

  it("sinaliza replay indisponível e responde pong", async () => {
    const { gateway } = createGateway(false)
    const socket = new FakeWebSocket()
    await gateway.handleConnection(socket as unknown as WebSocket, request)

    gateway.subscribe(socket as unknown as WebSocket, { type: "subscribe", channel: "task", taskId: 42, lastSequence: 0 })
    gateway.ping(socket as unknown as WebSocket)

    expect(messages(socket)).toEqual([
      { type: "replay_unavailable", taskId: 42, currentSequence: 2 },
      { type: "subscribed", taskId: 42, currentSequence: 2 },
      { type: "pong" },
    ])
  })

  it("rejeita conexão sem ticket válido e remove inscrições ao desconectar", async () => {
    const { gateway, jwt, realtime } = createGateway()
    const socket = new FakeWebSocket()

    await gateway.handleConnection(socket as unknown as WebSocket, { url: "/api/realtime/ws", headers: {} })
    expect(socket.closed).toEqual({ code: 1008, reason: "Não autorizado" })

    const connected = new FakeWebSocket()
    await gateway.handleConnection(connected as unknown as WebSocket, request)
    gateway.handleDisconnect(connected as unknown as WebSocket)
    expect(realtime.remover).toHaveBeenCalledWith(connected)
    expect(jwt.verifyAsync).toHaveBeenCalled()
  })
})
