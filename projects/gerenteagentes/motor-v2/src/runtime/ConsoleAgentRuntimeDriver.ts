/**
 * ConsoleAgentRuntimeDriver - Comunicacao HTTP/SSE com OpenClaw Console
 * Adaptado do motor antigo
 */

import { getConfigNumber } from '../config/MotorConfigReader.js'

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
  failure?: RemoteSessionFailure
}

export type RemoteFailureClassification = "transient" | "definitive" | "systemic"

export interface RemoteSessionFailure {
  code: string
  message: string
  sessionKey: string
  remoteSessionId?: string
  runId: string
  occurredAt: string
  scope: "session" | "run" | "console"
  classification: RemoteFailureClassification
  classificationReason: string
  fingerprint: string
}

export interface RuntimeSessionMessage {
  id?: string
  role: string
  content: unknown
  createdAt?: string
}

type SessionDescription = {
  status?: string
  state?: string
  endedAt?: number | string
  failedAt?: number | string
  hasActiveRun?: boolean
  stopReason?: string
  sessionId?: string
  id?: string
  errorCode?: string
  errorMessage?: string
  message?: string
  error?: SessionFailureDetail | string
  failure?: SessionFailureDetail | string
  details?: SessionFailureDetail
}

type SessionHistoryMessage = {
  role?: string
  content?: unknown
  errorCode?: unknown
  errorMessage?: unknown
  errorType?: unknown
  stopReason?: unknown
  timestamp?: unknown
}

type SessionFailureDetail = {
  code?: unknown
  message?: unknown
  occurredAt?: unknown
  failedAt?: unknown
  endedAt?: unknown
}

class ConsoleRequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = "ConsoleRequestError"
  }
}

export function normalizeRemoteTimestamp(value: number | string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined
  const numeric = typeof value === "number" ? value : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
  const date = Number.isFinite(numeric) ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric) : new Date(String(value))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export function classifyRemoteFailure(code: string, message: string): RemoteFailureClassification {
  const normalized = `${code} ${message}`.toUpperCase()
  // Indisponibilidade do gateway/Console é compartilhada por todas as
  // tarefas do agente. O coordenador pausa a fila e emite um único alerta,
  // em vez de bloquear cada tarefa como se fosse um erro de entrada.
  if (/CONSOLE_UNAVAILABLE|GATEWAY_UNAVAILABLE|GATEWAY_DOWN/i.test(normalized)) return "systemic"
  if (/^(HTTP_)?(408|409|425|429|500|502|503|504)$/.test(code.toUpperCase()) || /TIMEOUT|TEMPORARY|RATE_LIMITED|SESSION_BUSY|GATEWAY_UNAVAILABLE|UPSTREAM_RESET|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ABORT/i.test(normalized)) return "transient"
  if (/^(HTTP_)?(400|401|403|404|422)$/.test(code.toUpperCase()) || /INVALID_REQUEST|INVALID_SESSION|AUTH_FAILED|FORBIDDEN|AGENT_NOT_FOUND|MODEL_NOT_FOUND|WORKSPACE_INVALID|PROMPT_INVALID|PERMISSION_DENIED/i.test(normalized)) return "definitive"
  return "transient"
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
      timeoutMs: getConfigNumber('motor.console_send_timeout_ms'),
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
    const absoluteTimeoutMs = options.absoluteTimeoutMs ?? getConfigNumber('motor.console_run_absolute_timeout_ms')
    const idleTimeoutMs = options.idleTimeoutMs ?? getConfigNumber('motor.console_run_idle_timeout_ms')
    const pollInterval = options.pollIntervalMs ?? getConfigNumber('motor.console_poll_interval_ms')
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
        const desc = await this.request<SessionDescription>({
          method: "GET",
          path: "/api/sessions/describe",
          query: { key: session.key, agentId: session.agentId },
        })

        console.log("[ConsoleDriver] Polling describe:", { state: desc.state, status: desc.status, hasActiveRun: desc.hasActiveRun, endedAt: desc.endedAt })

        // Tratar falhas como erro
        if (desc.status === "failed" || desc.state === "failed") {
          const genericFailure = this.describeRemoteFailure(session, runId, desc, "session")
          const failure = await this.enrichFailureFromHistory(session, runId, genericFailure)
          return { state: "error", runId, errorMessage: failure.message, failure }
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
          const history = await this.request<{ messages: Array<{ id?: string; role: string; content: unknown }> }>({
            method: "GET",
            path: "/api/chat/history",
            query: { sessionKey: session.key, agentId: session.agentId, limit: 10, offset: 0 },
          })

          console.log("[ConsoleDriver] History:", { messageCount: history.messages?.length || 0, messages: history.messages?.map(m => ({ role: m.role, hasContent: !!m.content })) })

          const msgs = history.messages || []
          const lastAssistant = msgs.filter((m) => m.role === "assistant").pop()
          let content = lastAssistant
            ? (typeof lastAssistant.content === "string" ? lastAssistant.content : JSON.stringify(lastAssistant.content))
            : undefined

          if (lastAssistant?.id && content?.includes("...(truncated)...")) content = await this.readFullAssistantMessage(session, lastAssistant.id)

          // stopReason real quando o Console/Gateway expuser (ex.: "length"
          // = teto de saida do modelo); ausente => "done" (comportamento
          // historico). Permite ao motor distinguir fim normal de truncamento.
          const rawStopReason = (lastAssistant as { stopReason?: unknown } | undefined)?.stopReason
          const stopReason = typeof rawStopReason === "string" && rawStopReason.length > 0 ? rawStopReason : "done"

          return { state: "final", runId, content, stopReason }
        }

        if (desc.status === "error" || desc.state === "error") {
          const failure = this.describeRemoteFailure(session, runId, desc, "run")
          return { state: "error", runId, errorMessage: failure.message, failure }
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

  /**
   * Obtém o transcript canônico antes de arquivar ou reutilizar a sessão.
   * O Motor persiste essa cópia para que o Console não seja a única fonte de
   * recuperação de contexto em um retorno por gate reprovado.
   */
  async getSessionHistory(session: RuntimeSession): Promise<RuntimeSessionMessage[]> {
    const history = await this.request<{ messages: RuntimeSessionMessage[] }>({
      method: "GET",
      path: "/api/chat/history",
      query: { sessionKey: session.key, agentId: session.agentId, limit: 500, offset: 0 },
    })
    return Array.isArray(history.messages) ? history.messages : []
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

  /**
   * Lista todos os agentes registrados no gateway.
   * Diferente de getAgentWorkspace, este método PROPAGA erros (não os engole),
   * permitindo que o chamador (ex.: GatewayAgentVerificationPolicy) trate
   * falhas de rede/HTTP com diagnóstico claro.
   */
  async listAgents(): Promise<Array<{ id: string; workspace?: string }>> {
    const response = await this.request<{ agents: Array<{ id: string; workspace?: string }> }>({
      method: "GET",
      path: "/api/agents",
    })
    return response.agents ?? []
  }

  /**
   * Lista sessões de um agente específico.
   */
  async listSessions(agentId: string): Promise<Array<{ key: string; label?: string; agentId?: string }>> {
    const response = await this.request<{ sessions: Array<{ key: string; label?: string; agentId?: string }> }>({
      method: "GET",
      path: "/api/sessions",
      query: { agentId, limit: 100, offset: 0 },
    })
    return response.sessions ?? []
  }

  /**
   * Consulta o estado de uma sessão específica no OpenClaw.
   */
  async describeSession(sessionKey: string, agentId: string): Promise<SessionDescription> {
    return await this.request<SessionDescription>({
      method: "GET",
      path: "/api/sessions/describe",
      query: { key: sessionKey, agentId },
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

  private describeRemoteFailure(session: RuntimeSession, runId: string, desc: SessionDescription, scope: "session" | "run"): RemoteSessionFailure {
    // O endpoint de describe é a consulta detalhada do Console. Algumas
    // versões devolvem o detalhe em `error`, outras em `failure`/`details`;
    // nunca deixamos um payload parcial apagar o estado genérico observado.
    const detail = this.extractFailureDetail(desc)
    const state = desc.state || desc.status || "failed"
    const code = this.stringValue(detail?.code) || desc.errorCode || `SESSION_${state.toUpperCase()}`
    const message = (this.stringValue(detail?.message) || desc.errorMessage || desc.message || (state === "error" ? "Session ended with error" : "Session failed")).slice(0, 500)
    const occurredAt = normalizeRemoteTimestamp(this.firstTimestamp(detail?.occurredAt, detail?.failedAt, detail?.endedAt, desc.failedAt, desc.endedAt)) ?? new Date().toISOString()
    const classification = classifyRemoteFailure(code, message)
    return {
      code: String(code).slice(0, 120), message, sessionKey: session.key,
      ...(desc.sessionId || desc.id || session.sessionId ? { remoteSessionId: desc.sessionId || desc.id || session.sessionId } : {}),
      runId, occurredAt, scope, classification,
      classificationReason: classification === "systemic"
        ? "remote_code_or_message_indicates_shared_console_failure"
        : classification === "transient" ? "remote_code_or_message_indicates_retryable_failure" : "remote_failure_default_classification",
      fingerprint: `${code}:${message}`.slice(0, 600),
    }
  }

  /**
   * O endpoint de descrição pode devolver apenas `status=failed`, enquanto a
   * causa do provedor (por exemplo `429 insufficient_quota`) fica registrada
   * na última mensagem do assistente. Recuperar esse detalhe é necessário para
   * o worker promover imediatamente ao próximo modelo da cadeia.
   */
  private async enrichFailureFromHistory(
    session: RuntimeSession,
    runId: string,
    fallback: RemoteSessionFailure,
  ): Promise<RemoteSessionFailure> {
    try {
      const history = await this.request<{ messages?: SessionHistoryMessage[] }>({
        method: "GET",
        path: "/api/chat/history",
        query: { sessionKey: session.key, agentId: session.agentId, limit: 10, offset: 0 },
      })
      const assistant = (history.messages ?? []).filter((message) => message.role === "assistant").pop()
      const code = this.stringValue(assistant?.errorCode) || this.stringValue(assistant?.errorType)
      const message = this.stringValue(assistant?.errorMessage)
      if (!code && !message) return fallback

      const resolvedCode = (code || fallback.code).slice(0, 120)
      const resolvedMessage = (message || fallback.message).slice(0, 500)
      const classification = classifyRemoteFailure(resolvedCode, resolvedMessage)
      return {
        ...fallback,
        code: resolvedCode,
        message: resolvedMessage,
        occurredAt: normalizeRemoteTimestamp(
          typeof assistant?.timestamp === "number" || typeof assistant?.timestamp === "string"
            ? assistant.timestamp
            : undefined,
        ) ?? fallback.occurredAt,
        classification,
        classificationReason: classification === "systemic"
          ? "remote_code_or_message_indicates_shared_console_failure"
          : classification === "transient"
            ? "remote_code_or_message_indicates_retryable_failure"
            : "remote_failure_default_classification",
        fingerprint: `${resolvedCode}:${resolvedMessage}`.slice(0, 600),
        runId,
      }
    } catch {
      return fallback
    }
  }

  private extractFailureDetail(desc: SessionDescription): SessionFailureDetail | undefined {
    for (const candidate of [desc.error, desc.failure, desc.details]) {
      if (candidate && typeof candidate === "object") return candidate
    }
    return undefined
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }

  private firstTimestamp(...values: unknown[]): number | string | undefined {
    return values.find((value): value is number | string => typeof value === "number" || typeof value === "string")
  }

  async readFullAssistantMessage(session: RuntimeSession, messageId: string): Promise<string> {
    const full = await this.request<{ ok: boolean; message?: { role?: string; content?: unknown }; unavailableReason?: string }>({
      method: "GET",
      path: "/api/chat/message",
      query: { sessionKey: session.key, agentId: session.agentId, messageId, maxChars: 500_000 },
    })
    if (!full.ok || !full.message || full.message.role !== "assistant") {
      throw new Error(`Mensagem integral do analista indisponivel: ${full.unavailableReason || "resposta invalida"}`)
    }
    const content = typeof full.message.content === "string" ? full.message.content : JSON.stringify(full.message.content)
    if (content.length > 500_000) throw new Error("Mensagem integral do analista excede 500000 caracteres")
    return content
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
