import type { AnalystConsole, AnalystSession } from './ConsoleAnalystRunner.js'

export class ConsoleHttpApi implements AnalystConsole {
  private readonly pendingResponses = new Map<string, { assistantIds: Set<string>; sentAt: number }>()

  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async createSession(input: { key: string; agentId: string; model?: string; metadata: Record<string, unknown> }): Promise<AnalystSession> {
    const response = await this.request<{ sessionId?: string; id?: string; key?: string }>('/api/sessions', {
      // O contrato público do Console é estrito e não aceita metadados livres.
      // O contexto de correlação permanece no session key estável e no prompt.
      method: 'POST', body: { agentId: input.agentId, key: input.key, label: input.key, ...(input.model ? { model: input.model } : {}) },
    })
    const sessionId = response.sessionId ?? response.id
    if (!sessionId) throw new Error('Console não retornou sessionId')
    return { sessionId, sessionKey: response.key ?? input.key, agentId: input.agentId }
  }

  async sendMessage(input: { session: AnalystSession; message: string }): Promise<void> {
    // O endpoint de status pode continuar como `idle`/`hasActiveRun=false`
    // entre duas mensagens. Capture o histórico anterior para que a próxima
    // consulta não devolva a resposta antiga (por exemplo, o ACK do contexto)
    // como se fosse a resposta deste envio.
    const before = await this.history(input.session)
    const sentAt = Date.now()
    await this.request('/api/chat/send', { method: 'POST', body: { sessionKey: input.session.sessionKey, agentId: input.session.agentId, sessionId: input.session.sessionId, message: input.message } })
    this.pendingResponses.set(this.sessionKey(input.session), {
      assistantIds: new Set((before.messages ?? []).filter(message => message.role === 'assistant' && message.id).map(message => String(message.id))),
      sentAt,
    })
  }

  async getSessionStatus(session: AnalystSession): Promise<{ isComplete: boolean; isFailed?: boolean; lastResponse?: string; error?: string }> {
    const status = await this.request<{ status?: string; state?: string; hasActiveRun?: boolean; endedAt?: unknown; errorMessage?: string; message?: string; errorCode?: string; error?: unknown; failure?: unknown; details?: unknown }>('/api/sessions/describe', {
      method: 'GET', query: { key: session.sessionKey, agentId: session.agentId },
    })
    const terminalFailure = new Set(['failed', 'error', 'timeout', 'cancelled', 'canceled'])
    const failed = terminalFailure.has(String(status.status ?? '').toLowerCase()) || terminalFailure.has(String(status.state ?? '').toLowerCase())
    const complete = !failed && (status.status === 'done' || status.status === 'idle' || status.state === 'done' || status.state === 'idle' || status.hasActiveRun === false || status.endedAt !== undefined)
    if (!complete && !failed) return { isComplete: false }
    const history = await this.history(session)
    const marker = this.pendingResponses.get(this.sessionKey(session))
    const assistant = [...(history.messages ?? [])].reverse().find(message =>
      message.role === 'assistant' && this.isResponseAfter(message, marker) && this.isFinalAssistant(message),
    ) as
      | { role: string; content: unknown; errorCode?: unknown; errorType?: unknown; errorMessage?: unknown; stopReason?: unknown }
      | undefined
    if (failed) {
      // O Console por vezes expõe apenas status=failed. O histórico pode trazer
      // o detalhe do provedor ou apenas uma falha genérica com stopReason=error.
      const detail = this.failureText(status.error) ?? this.failureText(status.failure) ?? this.failureText(status.details)
      const error = this.stringValue(assistant?.errorMessage)
        ?? this.stringValue(assistant?.errorCode)
        ?? this.stringValue(assistant?.errorType)
        ?? this.stringValue(status.errorCode)
        ?? this.stringValue(status.errorMessage)
        ?? this.stringValue(status.message)
        ?? detail
        ?? (assistant?.stopReason === 'error'
          ? `SESSION_FAILED: ${this.stringValue(assistant.content) ?? 'falha antes de produzir resposta'}`
          : undefined)
        ?? `Sessão do Console terminou com status ${String(status.status ?? status.state ?? 'failed')}`
      this.pendingResponses.delete(this.sessionKey(session))
      return { isComplete: false, isFailed: true, error: error.slice(0, 800) }
    }
    // Estado ocioso sem uma mensagem nova ainda não é conclusão: o Console
    // pode estar entre o envio e a criação/registro da resposta.
    if (!assistant) return { isComplete: false }
    this.pendingResponses.delete(this.sessionKey(session))
    return { isComplete: true, lastResponse: String(assistant.content) }
  }

  private async history(session: AnalystSession): Promise<{ messages?: ConsoleHistoryMessage[] }> {
    return this.request<{ messages?: ConsoleHistoryMessage[] }>('/api/chat/history', {
      method: 'GET', query: { sessionKey: session.sessionKey, agentId: session.agentId, limit: 100 },
    })
  }

  private sessionKey(session: AnalystSession): string {
    return `${session.agentId}:${session.sessionKey}:${session.sessionId}`
  }

  private isResponseAfter(message: ConsoleHistoryMessage, marker?: { assistantIds: Set<string>; sentAt: number }): boolean {
    if (!marker) return true
    if (message.id && marker.assistantIds.has(String(message.id))) return false
    if (message.id) return true
    if (message.createdAt == null) return false
    const occurredAt = typeof message.createdAt === 'number' ? message.createdAt : Date.parse(String(message.createdAt))
    return Number.isFinite(occurredAt) && occurredAt >= marker.sentAt
  }

  private isFinalAssistant(message: ConsoleHistoryMessage): boolean {
    if (/^(?:toolUse|tool_use)$/i.test(String(message.stopReason ?? ''))) return false
    return typeof message.content === 'string' && message.content.trim().length > 0
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  private failureText(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const detail = value as { message?: unknown; error?: unknown; code?: unknown }
    return this.stringValue(detail.message) ?? this.stringValue(detail.error) ?? this.stringValue(detail.code)
  }

  /**
   * Arquiva a sessão no Console (best-effort). Falha não derruba o chamador —
   * o sanitize-session prossegue mesmo sem arquivamento remoto.
   */
  async archiveSession(sessionKey: string): Promise<{ archived: boolean; error?: string }> {
    try {
      await this.request('/api/sessions/archive', {
        method: 'POST',
        body: { key: sessionKey },
      })
      return { archived: true }
    } catch (error) {
      return { archived: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async request<T = unknown>(path: string, options: { method: 'GET' | 'POST'; body?: Record<string, unknown>; query?: Record<string, string | number> }): Promise<T> {
    const url = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value))
    const response = await fetch(url, {
      method: options.method,
      headers: { accept: 'application/json', authorization: `Bearer ${this.token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`Console HTTP ${response.status}: ${body.slice(0, 300)}`)
    return body ? JSON.parse(body) as T : {} as T
  }
}

type ConsoleHistoryMessage = {
  id?: string
  role: string
  content: unknown
  createdAt?: number | string
  errorCode?: unknown
  errorType?: unknown
  errorMessage?: unknown
  stopReason?: unknown
}
