import { realtimeServerMessageSchema, type RealtimeServerMessage } from "@biblioteca-global/shared"
import type { RealtimeClientOptions } from "./types"

// Defesa em profundidade contra a corrida de autenticação do handshake no
// servidor: o subscribe pode chegar antes de o RealtimeGateway registrar a
// sessão (handleConnection assíncrono), resultando em
// {type:"error",code:"INVALID_SUBSCRIPTION",message:"Inscrição inválida"}.
// O servidor reutiliza esse código para erros determinísticos ("Canal inválido",
// "Tarefa inválida", "Sessão HelpDesk inválida"), portanto o retry só é
// disparado para a assinatura exata da corrida (message === "Inscrição inválida").
const SUBSCRIBE_RETRY_DELAY_MS = 400
const SUBSCRIBE_RETRY_MAX_ATTEMPTS = 3
const SUBSCRIBE_RACE_ERROR_CODE = "INVALID_SUBSCRIPTION"
const SUBSCRIBE_RACE_ERROR_MESSAGE = "Inscrição inválida"

export class RealtimeClient {
  private socket: WebSocket | null = null
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly factory: (url: string) => WebSocket
  private readonly fetchImpl: typeof fetch
  private lastSequence: number | undefined
  private connectionGeneration = 0
  private readonly receivedEventIds = new Set<string>()
  // Estado do retry de subscribe (por conexão; reseta a cada onopen).
  private subscribeRetryTimer: ReturnType<typeof setTimeout> | null = null
  private subscribeRetryAttempts = 0
  private pendingSubscribeEnvelope: string | null = null

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
      const query = new URLSearchParams({ ticket })
      if ((this.options.channel ?? "task") === "task" && this.options.taskId !== undefined) {
        query.set("taskId", String(this.options.taskId))
      }
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
    const cancelarSubscribeRetry = (): void => {
      if (this.subscribeRetryTimer !== null) clearTimeout(this.subscribeRetryTimer)
      this.subscribeRetryTimer = null
    }
    const agendarSubscribeRetry = (): void => {
      // Só reenvia se a corrida ainda estiver pendente nesta conexão.
      if (this.socket !== socket) return
      if (this.pendingSubscribeEnvelope === null) return
      if (this.subscribeRetryAttempts >= SUBSCRIBE_RETRY_MAX_ATTEMPTS) return
      this.subscribeRetryAttempts += 1
      const envelope = this.pendingSubscribeEnvelope
      this.subscribeRetryTimer = setTimeout(() => {
        this.subscribeRetryTimer = null
        if (this.socket !== socket || this.stopped || this.pendingSubscribeEnvelope === null) return
        socket.send(envelope)
      }, SUBSCRIBE_RETRY_DELAY_MS)
    }
    socket.onopen = () => {
      this.options.onStatusChange?.("open")
      // Cada conexão nova recomeça o orçamento de retries do subscribe.
      cancelarSubscribeRetry()
      this.subscribeRetryAttempts = 0
      const channel = this.options.channel ?? "task"
      const subscribe = channel === "project-feed" || channel === "map"
        ? { type: "subscribe" as const, channel, lastSequence: this.lastSequence }
        : channel === "helpdesk"
          ? { type: "subscribe" as const, channel, sessaoId: this.options.sessaoId, lastSequence: this.lastSequence }
        : { type: "subscribe" as const, channel, taskId: this.options.taskId, lastSequence: this.lastSequence }
      // O WsAdapter padrão do NestJS roteia mensagens pelo campo "event".
      // Envelopar a inscrição no formato {"event":"subscribe","data":<payload>}
      // para que o @SubscribeMessage("subscribe") do RealtimeGateway seja acionado.
      // Mensagens servidor→cliente permanecem em JSON simples (campo "type").
      const envelope = { event: "subscribe", data: subscribe }
      this.pendingSubscribeEnvelope = JSON.stringify(envelope)
      socket.send(this.pendingSubscribeEnvelope)
    }
    socket.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data))
        const result = realtimeServerMessageSchema.safeParse(parsed)
        if (result.success) {
          if (result.data.type === "event") {
            // A reconexão pode repetir a última mensagem. Deduplicar antes de
            // entregar ao Mapa evita contadores e atividades duplicados.
            if (this.receivedEventIds.has(result.data.event.eventId)) return
            if (this.lastSequence !== undefined && result.data.event.sequence <= this.lastSequence) return
            this.receivedEventIds.add(result.data.event.eventId)
            this.lastSequence = Math.max(this.lastSequence ?? 0, result.data.event.sequence)
          } else if (result.data.type === "map_snapshot" || result.data.type === "task_snapshot" || result.data.type === "helpdesk_snapshot") {
            this.lastSequence = Math.max(this.lastSequence ?? 0, result.data.currentSequence)
          } else if (result.data.type === "error") {
            if (result.data.code === SUBSCRIBE_RACE_ERROR_CODE && result.data.message === SUBSCRIBE_RACE_ERROR_MESSAGE) {
              agendarSubscribeRetry()
            }
          } else if (
            result.data.type === "subscribed" ||
            result.data.type === "feed_subscribed" ||
            result.data.type === "map_subscribed" ||
            result.data.type === "helpdesk_subscribed"
          ) {
            // Inscrição confirmada: encerra qualquer retry pendente.
            cancelarSubscribeRetry()
            this.pendingSubscribeEnvelope = null
          }
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
    if (this.subscribeRetryTimer !== null) clearTimeout(this.subscribeRetryTimer)
    this.subscribeRetryTimer = null
    this.pendingSubscribeEnvelope = null
    this.socket?.close()
    this.socket = null
  }
}

export type { RealtimeServerMessage }
