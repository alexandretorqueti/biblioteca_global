import { realtimeServerMessageSchema, type RealtimeServerMessage } from "@biblioteca-global/shared"
import type { RealtimeClientOptions } from "./types"

export class RealtimeClient {
  private socket: WebSocket | null = null
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly factory: (url: string) => WebSocket
  private readonly fetchImpl: typeof fetch
  private lastSequence: number | undefined
  private connectionGeneration = 0

  constructor(private readonly options: RealtimeClientOptions) {
    this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url))
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.lastSequence = options.lastSequence
  }

  async connect(): Promise<void> {
    const generation = this.connectionGeneration
    this.stopped = false
    this.options.onStatusChange?.("connecting")
    try {
      // Solicitar ticket temporário via HTTP (cross-origin: cookie HttpOnly não chega no WS)
      const ticket = await this.solicitarTicket()
      // A troca de tarefa pode fechar o cliente enquanto o ticket ainda está
      // sendo obtido. Não crie um socket órfão quando essa chamada terminar.
      if (this.stopped || generation !== this.connectionGeneration) return
      const query = new URLSearchParams({ ticket, taskId: String(this.options.taskId) })
      if (this.lastSequence !== undefined) query.set("lastSequence", String(this.lastSequence))
      const socket = this.factory(`${this.options.url}?${query.toString()}`)
      this.conectarSocket(socket)
    } catch {
      this.options.onStatusChange?.("closed")
      if (!this.stopped) this.reconnectTimer = setTimeout(() => { void this.connect() }, 5000)
    }
  }

  private async solicitarTicket(): Promise<string> {
    const token = this.options.getAccessToken()
    if (!token) throw new Error("access token ausente")
    const res = await this.fetchImpl(`${this.options.baseUrl}/realtime/ticket`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`ticket: HTTP ${res.status}`)
    const body = await res.json() as { ticket: string }
    return body.ticket
  }

  private conectarSocket(socket: WebSocket): void {
    this.socket = socket
    socket.onopen = () => {
      this.options.onStatusChange?.("open")
      socket.send(JSON.stringify({ type: "subscribe", channel: "task", taskId: this.options.taskId, lastSequence: this.lastSequence }))
    }
    socket.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data))
        const result = realtimeServerMessageSchema.safeParse(parsed)
        if (result.success) {
          if (result.data.type === "event") this.lastSequence = Math.max(this.lastSequence ?? 0, result.data.event.sequence)
          this.options.onMessage(result.data)
        }
      } catch { /* mensagens inválidas são descartadas pelo cliente */ }
    }
    socket.onerror = (event) => this.options.onError?.(event)
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.options.onStatusChange?.("closed")
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 1000)
    }
  }

  close(): void {
    this.connectionGeneration += 1
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
  }
}

export type { RealtimeServerMessage }
