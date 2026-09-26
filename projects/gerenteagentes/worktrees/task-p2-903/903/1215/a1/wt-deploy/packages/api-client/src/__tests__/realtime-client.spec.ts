// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { RealtimeClient } from "../realtime"
import type { RealtimeClientOptions } from "../types"

class FakeWebSocket {
  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  closed = false

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  // Simula abertura da conexão
  simulateOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  // Simula mensagem recebida
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  // Simula fechamento
  simulateClose(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

describe("RealtimeClient", () => {
  let sockets: FakeWebSocket[]
  let fetchMock: ReturnType<typeof vi.fn>
  let options: RealtimeClientOptions

  beforeEach(() => {
    sockets = []
    fetchMock = vi.fn()
    options = {
      url: "ws://localhost/api/realtime/ws",
      baseUrl: "http://localhost/api",
      taskId: 123,
      getAccessToken: () => "access-token-mock",
      fetchImpl: fetchMock as unknown as typeof fetch,
      webSocketFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return ws as unknown as WebSocket
      },
      onMessage: vi.fn(),
      onStatusChange: vi.fn(),
    }
  })

  it("solicita ticket via HTTP e abre WebSocket com ticket na query", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-abc" }),
    })

    const client = new RealtimeClient(options)
    const connectPromise = client.connect()

    // Aguarda o WebSocket ser criado (após fetch do ticket)
    await vi.waitFor(() => expect(sockets[0]).toBeDefined())
    const ws = sockets[0]!
    expect(ws.url).toContain("ticket=ticket-abc")
    expect(ws.url).toContain("taskId=123")

    // Simula abertura do WebSocket
    ws.simulateOpen()
    await connectPromise

    // Verifica que enviou subscribe
    expect(ws.sent[0]).toContain('"type":"subscribe"')
    expect(ws.sent[0]).toContain('"taskId":123')
  })

  it("inclui Authorization Bearer no request do ticket", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-xyz" }),
    })

    const client = new RealtimeClient(options)
    void client.connect()

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/realtime/ticket",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer access-token-mock" },
      }),
    )
  })

  it("rejeita conexão se fetch do ticket falhar", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })

    const client = new RealtimeClient(options)
    await client.connect()

    // onStatusChange deve ter sido chamado com "closed"
    expect(options.onStatusChange).toHaveBeenCalledWith("closed")
    // Nenhum WebSocket deve ter sido criado
    expect(sockets).toHaveLength(0)
  })

  it("rejeita conexão se getAccessToken retornar null", async () => {
    options.getAccessToken = () => null

    const client = new RealtimeClient(options)
    await client.connect()

    expect(options.onStatusChange).toHaveBeenCalledWith("closed")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(0)
  })

  it("reconecta após falha no ticket com backoff de 5s", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

    const client = new RealtimeClient(options)
    await client.connect()

    expect(options.onStatusChange).toHaveBeenCalledWith("closed")
    expect(sockets).toHaveLength(0)

    // Avança 5s — deve tentar reconectar
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalled()

    vi.useRealTimers()
  })

  it("close() impede reconexão", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

    const client = new RealtimeClient(options)
    await client.connect()
    client.close()

    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock).not.toHaveBeenCalled()

    vi.useRealTimers()
  })
})
