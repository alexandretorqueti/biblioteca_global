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
  /** Diretório de trabalho efetivo da sessão no Console. */
  workspacePath?: string
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

export interface WaitForRunOptions {
  /** Teto absoluto de espera (padrão 4h). Segurança contra runs zumbi. */
  absoluteTimeoutMs?: number
  /**
   * Timeout de INATIVIDADE (padrão 10min): só falha se a sessão ficar esse
   * tempo sem sinal de progresso (estados-limbo nem ativos nem terminais, ou
   * console inalcançável). Enquanto o run reporta atividade (hasActiveRun /
   * estados busy/running/streaming), o prazo é renovado continuamente —
   * modelo trabalhando não é mais interrompido por relógio (2026-08-31).
   */
  idleTimeoutMs?: number
  pollIntervalMs?: number
  /** Chamado a cada polling que enxerga o run ativo (ex.: heartbeat ao coordenador). */
  onActivity?: () => void
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
      body: {
        agentId: input.agentId,
        key: input.key,
        label: input.label,
        model: input.model,
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      },
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
   * Aguarda conclusao do run via polling (describe + history).
   * Fallback robusto quando SSE nao captura o evento final.
   *
   * B7 (2026-08-31): timeout absoluto de 30min substituído por timeout de
   * inatividade — run ativo renova o prazo; só falha por inatividade
   * (sem progresso por idleTimeoutMs) ou pelo teto absoluto (4h).
   */
  async waitForRunCompletion(session: RuntimeSession, runId: string, options: WaitForRunOptions = {}): Promise<AgentRunCompletion> {
    const absoluteTimeoutMs = options.absoluteTimeoutMs ?? 14_400_000
    const idleTimeoutMs = options.idleTimeoutMs ?? 600_000
    const pollInterval = options.pollIntervalMs ?? 5000
    const startMs = Date.now()
    let lastActivityMs = Date.now()

    // Aguarda inicial para o run começar
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, pollInterval)))

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))

      if (Date.now() - startMs > absoluteTimeoutMs) {
        throw new Error(`Timeout absoluto (${absoluteTimeoutMs}ms) aguardando conclusao do run`)
      }

      try {
        const desc = await this.request<{
          status?: string
          state?: string
          endedAt?: number
          hasActiveRun?: boolean
          stopReason?: string
        }>({
          method: "GET",
          path: "/api/sessions/describe",
          query: { key: session.key, agentId: session.agentId },
        })

        console.log("[ConsoleDriver] Polling describe:", { state: desc.state, status: desc.status, hasActiveRun: desc.hasActiveRun, endedAt: desc.endedAt })

        // Tratar falhas como erro
        if (desc.status === "failed" || desc.state === "failed") {
          return { state: "error", runId, errorMessage: "Session failed" }
        }

        // Run ATIVO: renova o prazo de inatividade e avisa o interessado.
        // Modelo trabalhando não é interrompido por relógio.
        const active =
          desc.hasActiveRun === true ||
          desc.state === "busy" || desc.state === "running" || desc.state === "streaming" ||
          desc.status === "busy" || desc.status === "running" || desc.status === "streaming"
        if (active) {
          lastActivityMs = Date.now()
          options.onActivity?.()
        }

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

          console.log("[ConsoleDriver] History:", { messageCount: history.messages?.length || 0, messages: history.messages?.map(m => ({ role: m.role, hasContent: !!m.content })) })

          const msgs = history.messages || []
          const lastAssistant = msgs.filter((m) => m.role === "assistant").pop()
          const content = lastAssistant
            ? (typeof lastAssistant.content === "string" ? lastAssistant.content : JSON.stringify(lastAssistant.content))
            : undefined

          // stopReason real quando o Console/Gateway expuser (ex.: "length"
          // = teto de saida do modelo); ausente => "done" (comportamento
          // historico). Permite ao motor distinguir fim normal de truncamento.
          const rawStopReason = (lastAssistant as { stopReason?: unknown } | undefined)?.stopReason
          const stopReason = typeof rawStopReason === "string" && rawStopReason.length > 0 ? rawStopReason : "done"

          return { state: "final", runId, content, stopReason }
        }

        if (desc.status === "error" || desc.state === "error") {
          return { state: "error", runId, errorMessage: "Session ended with error" }
        }

        // Estado-limbo (nem ativo, nem terminal): não renova atividade.
      } catch (error) {
        // Continua polling se erro de rede — mas não conta como atividade.
        console.warn("[ConsoleDriver] Polling error:", error instanceof Error ? error.message : String(error))
      }

      if (Date.now() - lastActivityMs > idleTimeoutMs) {
        throw new Error(`Timeout por inatividade (${idleTimeoutMs}ms sem progresso) aguardando conclusao do run`)
      }
    }
  }

  async closeSession(session: RuntimeSession): Promise<void> {
    await this.request({
      method: "DELETE",
      path: "/api/sessions",
      body: { key: session.key, agentId: session.agentId },
    })
  }

  async getAgentWorkspace(agentId: string): Promise<string | null> {
    try {
      const response = await this.request<{ agents: Array<{ id: string; workspace?: string }> }>({
        method: "GET",
        path: "/api/agents",
      })
      const agent = response.agents.find((a) => a.id === agentId)
      return agent?.workspace ?? null
    } catch {
      return null
    }
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
