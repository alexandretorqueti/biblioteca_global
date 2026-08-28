/**
 * Driver do motor-v2 que fala HTTP com o OpenClaw Console (porta 6280).
 * Baseado no ConsoleAgentRuntimeDriver do motor antigo.
 *
 * Contrato:
 * - Auth: Authorization: Bearer <token>
 * - POST /api/sessions: cria sessão
 * - POST /api/chat/send: envia mensagem
 * - GET /api/chat/history: busca histórico
 * - SSE /api/events: stream de eventos
 */

export interface RuntimeSession {
  key: string
  agentId: string
  label?: string
  model?: string
}

export interface AgentExecutionInput {
  sessionKey: string
  agentId: string
  prompt: string
  model?: string
}

export interface AgentExecutionOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface AgentRunCompletion {
  ok: boolean
  stopReason?: string
  errorMessage?: string
}

export interface CreateRuntimeSessionInput {
  agentId: string
  key?: string
  label?: string
  model?: string
}

export interface SessionActivity {
  lastActivityAt?: string
  status?: string
}

export interface SessionHistoryMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
}

export interface ConsoleTransportOptions {
  baseUrl: string
  token: string
  fetchImpl?: typeof fetch
}

class ConsoleRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ConsoleRequestError'
  }
}

export class ConsoleAgentRuntimeDriver {
  private baseUrl: string
  private token: string
  private fetchImpl: typeof fetch

  constructor(options: ConsoleTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession> {
    const response = await this.request<{ key: string; agentId: string; label?: string; model?: string }>({
      method: 'POST',
      path: '/api/sessions',
      body: {
        agentId: input.agentId,
        key: input.key,
        label: input.label,
        model: input.model,
      },
    })

    return {
      key: response.key,
      agentId: response.agentId,
      label: response.label,
      model: response.model,
    }
  }

  async sendMessage(input: AgentExecutionInput, options?: AgentExecutionOptions): Promise<AgentRunCompletion> {
    const response = await this.request<{ ok: boolean; stopReason?: string; errorMessage?: string }>({
      method: 'POST',
      path: '/api/chat/send',
      body: {
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        message: input.prompt,
        model: input.model,
      },
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })

    return {
      ok: response.ok,
      stopReason: response.stopReason,
      errorMessage: response.errorMessage,
    }
  }

  async getHistory(sessionKey: string, limit = 50): Promise<SessionHistoryMessage[]> {
    const response = await this.request<{ messages: SessionHistoryMessage[] }>({
      method: 'GET',
      path: '/api/chat/history',
      query: { sessionKey, limit },
    })

    return response.messages
  }

  async getSessionActivity(sessionKey: string): Promise<SessionActivity> {
    const response = await this.request<SessionActivity>({
      method: 'GET',
      path: `/api/sessions/${encodeURIComponent(sessionKey)}/activity`,
    })

    return response
  }

  private async request<T>(options: {
    method: 'GET' | 'POST' | 'PATCH'
    path: string
    body?: unknown
    query?: Record<string, string | number>
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<T> {
    const url = new URL(options.path, this.baseUrl)
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, String(value))
      }
    }

    const controller = new AbortController()
    const timeout = options.timeoutMs ?? 30_000
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort())
    }

    try {
      const response = await this.fetchImpl(url.toString(), {
        method: options.method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: { code: 'UNKNOWN', message: response.statusText } }))
        throw new ConsoleRequestError(
          response.status,
          errorBody.error?.code ?? 'UNKNOWN',
          errorBody.error?.message ?? response.statusText,
        )
      }

      return await response.json() as T
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
