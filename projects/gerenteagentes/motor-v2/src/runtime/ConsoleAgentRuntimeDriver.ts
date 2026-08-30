/**
 * ConsoleAgentRuntimeDriver - Comunicacao HTTP/SSE com OpenClaw Console
 * Adaptado do motor antigo
 */

export interface ConsoleTransportOptions {
  baseUrl: string
  token: string
}

export interface CreateSessionInput {
  agentId: string
  key?: string
  label?: string
  model?: string
}

export interface RuntimeSession {
  key: string
  agentId: string
  sessionId?: string
}

export interface SendMessageInput {
  session: RuntimeSession
  message: string
  idempotencyKey?: string
}

export interface AgentRunCompletion {
  state: "final" | "aborted" | "error"
  runId: string
  content?: string
  stopReason?: string
  errorMessage?: string
}

class ConsoleRequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = "ConsoleRequestError"
  }
}

export class ConsoleAgentRuntimeDriver {
  private baseUrl: string
  private token: string

  constructor(options: ConsoleTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.token = options.token
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSession> {
    const response = await this.request<{ key: string; sessionId?: string }>({
      method: "POST",
      path: "/api/sessions",
      body: { agentId: input.agentId, key: input.key, label: input.label, model: input.model },
    })
    await this.request({
      method: "PATCH",
      path: "/api/sessions",
      body: { key: response.key, agentId: input.agentId, archived: false },
    })
    return { key: response.key, agentId: input.agentId, sessionId: response.sessionId }
  }

  async sendMessage(input: SendMessageInput): Promise<{ runId: string }> {
    const response = await this.request<{ runId: string }>({
      method: "POST",
      path: "/api/chat/send",
      body: {
        sessionKey: input.session.key,
        agentId: input.session.agentId,
        message: input.message,
        ...(input.session.sessionId ? { sessionId: input.session.sessionId } : {}),
      },
      timeoutMs: 600_000,
    })
    return { runId: response.runId }
  }

  /**
   * Aguarda conclusao do run via polling (describe + history)
   * Fallback robusto quando SSE nao captura o evento final
   */
  async waitForRunCompletion(session: RuntimeSession, runId: string, timeoutMs = 1_800_000): Promise<AgentRunCompletion> {
    const startMs = Date.now()
    const pollInterval = 5000

    while (Date.now() - startMs < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))

      try {
        const desc = await this.request<{
          status?: string
          state?: string
          endedAt?: number
          hasActiveRun?: boolean
        }>({
          method: "GET",
          path: "/api/sessions/describe",
          query: { key: session.key, agentId: session.agentId },
        })

        // O Console atual expõe `state`/`hasActiveRun` na listagem normalizada;
        // versões anteriores usavam `status`. Aceitar ambos os contratos evita
        // esperar até timeout quando a execução já terminou.
        if (
          desc.status === "done" || desc.status === "idle" ||
          desc.state === "done" || desc.state === "idle" ||
          desc.hasActiveRun === false || desc.endedAt !== undefined
        ) {
          // Sessao terminou, buscar historico
          const history = await this.request<{ messages: Array<{ role: string; content: unknown }> }>({
            method: "GET",
            path: "/api/chat/history",
            query: { sessionKey: session.key, agentId: session.agentId, limit: 10, offset: 0 },
          })

          const msgs = history.messages || []
          const lastAssistant = msgs.filter((m) => m.role === "assistant").pop()
          const content = lastAssistant
            ? (typeof lastAssistant.content === "string" ? lastAssistant.content : JSON.stringify(lastAssistant.content))
            : undefined

          return { state: "final", runId, content, stopReason: "done" }
        }

        if (desc.status === "error" || desc.state === "error") {
          return { state: "error", runId, errorMessage: "Session ended with error" }
        }
      } catch (error) {
        // Continua polling se erro de rede
        console.warn("[ConsoleDriver] Polling error:", error instanceof Error ? error.message : String(error))
      }
    }

    throw new Error("Timeout waiting for run completion")
  }

  async closeSession(session: RuntimeSession): Promise<void> {
    await this.request({
      method: "DELETE",
      path: "/api/sessions",
      body: { key: session.key, agentId: session.agentId },
    })
  }

  async readSessionHistory(session: RuntimeSession, limit = 50): Promise<Array<{ role: string; content: string }>> {
    const response = await this.request<{ messages: Array<{ role: string; content: unknown }> }>({
      method: "GET",
      path: "/api/chat/history",
      query: { sessionKey: session.key, agentId: session.agentId, limit, offset: 0 },
    })

    return (response.messages || [])
      .map((msg) => ({
        role: msg.role,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      }))
      .filter((msg) => msg.content.trim().length > 0)
  }

  private async request<T>(options: {
    method: "GET" | "POST" | "PATCH" | "DELETE"
    path: string
    body?: unknown
    query?: Record<string, string | number>
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<T> {
    const url = new URL(options.path, this.baseUrl)
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, String(value))
    }
    const signals: AbortSignal[] = []
    if (options.signal) signals.push(options.signal)
    if (options.timeoutMs) signals.push(AbortSignal.timeout(options.timeoutMs))
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined

    let response: Response
    try {
      response = await fetch(url.toString(), {
        method: options.method,
        headers: {
          Authorization: "Bearer " + this.token,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      const context = options.body as Record<string, unknown> | undefined
      const query = options.query ?? {}
      console.error("[ConsoleDriver] request_failed", {
        method: options.method,
        path: options.path,
        host: url.host,
        agentId: typeof context?.agentId === "string" ? context.agentId : undefined,
        sessionKey: typeof context?.sessionKey === "string" ? context.sessionKey :
          typeof query.key === "string" ? query.key : undefined,
        cause: this.describeError(error),
      })
      throw error
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
      const error = (payload?.error as Record<string, unknown>) || {}
      console.error("[ConsoleDriver] request_rejected", {
        method: options.method,
        path: options.path,
        host: url.host,
        status: response.status,
        code: typeof error.code === "string" ? error.code : "HTTP_" + response.status,
      })
      throw new ConsoleRequestError(
        response.status,
        typeof error.code === "string" ? error.code : "HTTP_" + response.status,
        typeof error.message === "string" ? error.message : "Console returned HTTP " + response.status,
      )
    }
    return response.json() as Promise<T>
  }

  private describeError(error: unknown): string {
    if (!(error instanceof Error)) return String(error)
    const cause = error.cause
    if (cause instanceof Error) return `${error.name}: ${error.message}; cause=${cause.name}: ${cause.message}`
    if (cause !== undefined) return `${error.name}: ${error.message}; cause=${String(cause)}`
    return `${error.name}: ${error.message}`
  }
}
