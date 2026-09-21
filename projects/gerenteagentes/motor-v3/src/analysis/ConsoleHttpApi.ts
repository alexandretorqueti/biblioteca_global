import type { AnalystConsole, AnalystSession } from './ConsoleAnalystRunner.js'

export class ConsoleHttpApi implements AnalystConsole {
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
    await this.request('/api/chat/send', { method: 'POST', body: { sessionKey: input.session.sessionKey, agentId: input.session.agentId, sessionId: input.session.sessionId, message: input.message } })
  }

  async getSessionStatus(session: AnalystSession): Promise<{ isComplete: boolean; isFailed?: boolean; lastResponse?: string; error?: string }> {
    const status = await this.request<{ status?: string; state?: string; hasActiveRun?: boolean; endedAt?: unknown; errorMessage?: string; message?: string; errorCode?: string; error?: unknown; failure?: unknown; details?: unknown }>('/api/sessions/describe', {
      method: 'GET', query: { key: session.sessionKey, agentId: session.agentId },
    })
    const failed = status.status === 'failed' || status.state === 'failed' || status.status === 'error' || status.state === 'error'
    const complete = !failed && (status.status === 'done' || status.status === 'idle' || status.state === 'done' || status.state === 'idle' || status.hasActiveRun === false || status.endedAt !== undefined)
    if (!complete && !failed) return { isComplete: false }
    const history = await this.request<{ messages?: Array<{ role: string; content: unknown }> }>('/api/chat/history', {
      method: 'GET', query: { sessionKey: session.sessionKey, agentId: session.agentId, limit: 20 },
    })
    if (failed) {
      // O Console por vezes expõe apenas status=failed. A última mensagem do
      // assistente contém o erro do provedor (quota, rate-limit etc.).
      const assistant = [...(history.messages ?? [])].reverse().find(message => message.role === 'assistant') as
        | { role: string; content: unknown; errorCode?: unknown; errorType?: unknown; errorMessage?: unknown; stopReason?: unknown }
        | undefined
      const detail = this.failureText(status.error) ?? this.failureText(status.failure) ?? this.failureText(status.details)
      const error = this.stringValue(assistant?.errorMessage)
        ?? this.stringValue(assistant?.errorCode)
        ?? this.stringValue(assistant?.errorType)
        ?? this.stringValue(status.errorCode)
        ?? this.stringValue(status.errorMessage)
        ?? this.stringValue(status.message)
        ?? detail
        ?? (assistant?.stopReason === 'error' ? this.stringValue(assistant.content) : undefined)
        ?? 'Sessão do Console falhou sem detalhamento'
      return { isComplete: false, isFailed: true, error: error.slice(0, 800) }
    }
    const assistant = [...(history.messages ?? [])].reverse().find(message => message.role === 'assistant')
    return { isComplete: true, lastResponse: assistant ? String(assistant.content) : undefined }
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  private failureText(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const detail = value as { message?: unknown; error?: unknown; code?: unknown }
    return this.stringValue(detail.message) ?? this.stringValue(detail.error) ?? this.stringValue(detail.code)
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
