import type { AnalystConsole } from './ConsoleAnalystRunner.js'

export class ConsoleHttpApi implements AnalystConsole {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async createSession(input: { key: string; agentId: string; metadata: Record<string, unknown> }): Promise<{ sessionId: string }> {
    const response = await this.request<{ sessionId?: string; id?: string }>('/api/sessions', {
      method: 'POST', body: { agentId: input.agentId, key: input.key, label: input.key, metadata: input.metadata },
    })
    const sessionId = response.sessionId ?? response.id
    if (!sessionId) throw new Error('Console não retornou sessionId')
    return { sessionId }
  }

  async sendMessage(input: { sessionId: string; message: string }): Promise<void> {
    await this.request('/api/chat/send', { method: 'POST', body: { sessionId: input.sessionId, message: input.message } })
  }

  async getSessionStatus(sessionId: string): Promise<{ isComplete: boolean; isFailed?: boolean; lastResponse?: string; error?: string }> {
    const status = await this.request<{ status?: string; state?: string; hasActiveRun?: boolean; errorMessage?: string }>('/api/sessions/describe', {
      method: 'GET', query: { sessionId },
    })
    const failed = status.status === 'failed' || status.state === 'failed' || status.status === 'error' || status.state === 'error'
    const complete = !failed && (status.status === 'done' || status.status === 'idle' || status.state === 'done' || status.state === 'idle' || status.hasActiveRun === false)
    if (!complete && !failed) return { isComplete: false }
    if (failed) return { isComplete: false, isFailed: true, error: status.errorMessage }
    const history = await this.request<{ messages?: Array<{ role: string; content: unknown }> }>('/api/chat/history', {
      method: 'GET', query: { sessionId, limit: 20 },
    })
    const assistant = [...(history.messages ?? [])].reverse().find(message => message.role === 'assistant')
    return { isComplete: true, lastResponse: assistant ? String(assistant.content) : undefined }
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
