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
  async waitForRunCompletion(session: RuntimeSession, runId: string, timeoutMs = 600_000): Promise<AgentRunCompletion> {
    const startMs = Date.now()
    const pollInterval = 5000

    while (Date.now() - startMs < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))

      try {
        const desc = await this.request<{ status?: string; endedAt?: number }>({
          method: "GET",
          path: "/api/sessions/describe",
          query: { key: session.key, agentId: session.agentId },
        })

        if (desc.status === "done" || desc.status === "idle") {
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

        if (desc.status === "error") {
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
      method: "PATCH",
      path: "/api/sessions",
      body: { key: session.key, agentId: session.agentId, archived: true },
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
    method: "GET" | "POST" | "PATCH"
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

    const response = await fetch(url.toString(), {
      method: options.method,
      headers: {
        Authorization: "Bearer " + this.token,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
      const error = (payload?.error as Record<string, unknown>) || {}
      throw new ConsoleRequestError(
        response.status,
        typeof error.code === "string" ? error.code : "HTTP_" + response.status,
        typeof error.message === "string" ? error.message : "Console returned HTTP " + response.status,
      )
    }
    return response.json() as Promise<T>
  }
}
