import { realtimeServerMessageSchema, type RealtimeServerMessage } from "@biblioteca-global/shared"
import type { RealtimeClientOptions } from "./types"

export class RealtimeClient {
  private socket: WebSocket | null = null
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly factory: (url: string) => WebSocket
  private lastSequence: number | undefined

  constructor(private readonly options: RealtimeClientOptions) {
    this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url))
    this.lastSequence = options.lastSequence
  }

  connect(): void {
    this.stopped = false
    this.options.onStatusChange?.("connecting")
    const query = new URLSearchParams({ taskId: String(this.options.taskId) })
    if (this.lastSequence !== undefined) query.set("lastSequence", String(this.lastSequence))
    const socket = this.factory(`${this.options.url}?${query.toString()}`)
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
      this.options.onStatusChange?.("closed")
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 1000)
    }
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
  }
}

export type { RealtimeServerMessage }
