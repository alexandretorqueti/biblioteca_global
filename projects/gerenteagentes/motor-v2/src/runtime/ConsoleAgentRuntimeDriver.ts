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

  async waitForRunCompletion(session: RuntimeSession, runId: string, timeoutMs = 600_000): Promise<AgentRunCompletion> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      for await (const frame of this.openEventStream(controller.signal)) {
        if (frame.event !== "chat") continue
        let payload: Record<string, unknown>
        try { payload = JSON.parse(frame.data) } catch { continue }
        if (payload.sessionKey !== session.key || payload.runId !== runId) continue
        const state = payload.state
        if (state !== "final" && state !== "aborted" && state !== "error") continue
        const message = payload.message as Record<string, unknown> | undefined
        return {
          state: state as AgentRunCompletion["state"],
          runId,
          content: typeof message?.content === "string" ? message.content : undefined,
          stopReason: typeof payload.stopReason === "string" ? payload.stopReason : undefined,
          errorMessage: typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
        }
      }
      throw new Error("Event stream closed before completion")
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  async closeSession(session: RuntimeSession): Promise<void> {
    await this.request({
      method: "PATCH",
      path: "/api/sessions",
      body: { key: session.key, agentId: session.agentId, archived: true },
    })
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

  private async *openEventStream(signal?: AbortSignal): AsyncIterable<{ event?: string; data: string }> {
    const response = await fetch(this.baseUrl + "/api/events", {
      headers: { Authorization: "Bearer " + this.token, Accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    })
    if (!response.ok || !response.body) throw new ConsoleRequestError(response.status, "HTTP_" + response.status, "SSE stream failed")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        let eventType: string | undefined
        let data = ""
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim()
          else if (line.startsWith("data:")) data = line.slice(5).trim()
          else if (line === "" && data) { yield { event: eventType, data }; eventType = undefined; data = "" }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
