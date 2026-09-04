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

  // --------------------------------------------------------------------------
  // Reconexão após queda de WebSocket (st-4)
  // --------------------------------------------------------------------------

  it("reconecta automaticamente após WebSocket fechar (backoff 1s)", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-1" }),
    })

    const client = new RealtimeClient(options)
    void client.connect()

    // Aguardar o primeiro WebSocket ser criado e abrir.
    await vi.waitFor(() => expect(sockets[0]).toBeDefined())
    const ws1 = sockets[0]!
    ws1.simulateOpen()

    expect(options.onStatusChange).toHaveBeenCalledWith("open")

    // Simular queda do WebSocket (close inesperado).
    ws1.simulateClose()
    expect(options.onStatusChange).toHaveBeenCalledWith("closed")

    // Avancar 1s — deve tentar reconectar (novo ticket + novo WebSocket).
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-2" }),
    })
    await vi.advanceTimersByTimeAsync(1000)

    // Segundo WebSocket deve ter sido criado.
    await vi.waitFor(() => expect(sockets[1]).toBeDefined())
    const ws2 = sockets[1]!
    expect(ws2.url).toContain("ticket=ticket-2")

    ws2.simulateOpen()
    expect(options.onStatusChange).toHaveBeenCalledWith("open")

    client.close()
    vi.useRealTimers()
  })

  it("close() durante reconexão pendente cancela o timer", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-1" }),
    })

    const client = new RealtimeClient(options)
    void client.connect()

    await vi.waitFor(() => expect(sockets[0]).toBeDefined())
    sockets[0]!.simulateOpen()

    // Queda do WebSocket.
    sockets[0]!.simulateClose()

    // Fechar imediatamente (antes do timer de 1s).
    client.close()

    // Avancar 5s — nenhuma reconexão deve ocorrer.
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1) // apenas o original

    vi.useRealTimers()
  })

  // --------------------------------------------------------------------------
  // Processamento de mensagens (st-4)
  // --------------------------------------------------------------------------

  it("repassa mensagens válidas do servidor para onMessage", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-msg" }),
    })

    const client = new RealtimeClient(options)
    void client.connect()

    await vi.waitFor(() => expect(sockets[0]).toBeDefined())
    sockets[0]!.simulateOpen()

    // Mensagem "subscribed" válida.
    sockets[0]!.simulateMessage({
      type: "subscribed",
      taskId: 123,
      currentSequence: 5,
    })

    expect(options.onMessage).toHaveBeenCalledWith({
      type: "subscribed",
      taskId: 123,
      currentSequence: 5,
    })

    client.close()
  })

  it("rastrea sequence de eventos e inclui lastSequence na reconexão", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-seq" }),
    })

    const client = new RealtimeClient(options)
    void client.connect()

    await vi.waitFor(() => expect(sockets[0]).toBeDefined())
    sockets[0]!.simulateOpen()

    // Enviar evento com sequence.
    sockets[0]!.simulateMessage({
      type: "event",
      event: {
        eventId: "e1",
        occurredAt: "2026-09-01T10:00:00Z",
        source: "motor",
        projectId: 1,
        taskId: 123,
        type: "task.status.changed",
        sequence: 7,
        payload: { status: "running" },
      },
    })

    expect(options.onMessage).toHaveBeenCalled()

    // Queda + reconexão.
    sockets[0]!.simulateClose()

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-seq-2" }),
    })
    await vi.advanceTimersByTimeAsync(1000)

    await vi.waitFor(() => expect(sockets[1]).toBeDefined())
    sockets[1]!.simulateOpen()

    // O subscribe da reconexão deve incluir lastSequence=7.
    const subscribeMsg = JSON.parse(sockets[1]!.sent[0]!)
    expect(subscribeMsg.lastSequence).toBe(7)

    client.close()
    vi.useRealTimers()
  })

  it("descarta mensagens inválidas (JSON malformado) sem erro", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-bad" }),
    })

    const client = new RealtimeClient(options)
    void client.connect()

    await vi.waitFor(() => expect(sockets[0]).toBeDefined())
    sockets[0]!.simulateOpen()

    // Mensagem com JSON inválido — não deve disparar onMessage.
    sockets[0]!.simulateMessage({ invalid: true })

    expect(options.onMessage).not.toHaveBeenCalled()

    client.close()
  })

  it("inclui lastSequence inicial (do construtor) no subscribe", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ticket: "ticket-init" }),
    })

    options.lastSequence = 42
    const client = new RealtimeClient(options)
    void client.connect()

    await vi.waitFor(() => expect(sockets[0]).toBeDefined())
    sockets[0]!.simulateOpen()

    const subscribeMsg = JSON.parse(sockets[0]!.sent[0]!)
    expect(subscribeMsg.lastSequence).toBe(42)

    client.close()
  })
})
