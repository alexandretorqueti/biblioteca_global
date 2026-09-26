/**
 * Cliente tipado para conversas com agentes.
 *
 * Este módulo concentra o transporte HTTP do AgentChat. A UI recebe a
 * interface AgentChatDriver e não conhece rotas, tokens ou fetch.
 */
import {
  chatHistorySchema,
  type ChatAttachment,
  type AgentChatDataSource,
  type ChatHistory,
  type ChatSession,
  type SendChatMessageInput,
  type SendChatMessageResult,
  type StartChatSessionInput,
} from "@biblioteca-global/shared"
import { ApiClientError } from "./errors"
import type { ApiHttpClient } from "./http"

export interface AgentChatEndpointConfig {
  sessionPath?: string
  historyPath?: (chatId: string) => string
  sendPath?: string
  visitPath?: string
  /** Permite adaptar nomes de campos de um backend já existente. */
  buildSessionBody?: (input: StartChatSessionInput) => Record<string, unknown>
  buildSendBody?: (input: SendChatMessageInput) => Record<string, unknown>
  buildVisitBody?: (visitorKey: string, pageUrl: string) => Record<string, unknown>
  /** Converte extensões do histórico legado em metadados neutros para a UI. */
  historyMetadata?: (data: Record<string, unknown>) => Record<string, unknown> | undefined
}

export interface AgentChatClientOptions {
  http: ApiHttpClient
  agentId: string
  visitorKey: string
  endpoints?: AgentChatEndpointConfig
}

export interface AgentChatOutboxEntry {
  id: number
  input: SendChatMessageInput
  queuedAt: string
}

export interface AgentChatDriver extends AgentChatDataSource {
  recordVisit(pageUrl?: string): Promise<boolean>
  readonly outbox: readonly AgentChatOutboxEntry[]
  flushOutbox(): Promise<number>
}

const DEFAULT_SESSION_PATH = "/agent-chat/session"
const DEFAULT_SEND_PATH = "/agent-chat/send"
const DEFAULT_VISIT_PATH = "/agent-chat/site-visit"

function erroRespostaInvalida(message: string, details?: unknown): ApiClientError {
  return new ApiClientError(502, "INVALID_AGENT_CHAT_RESPONSE", message, details)
}

/** Cria um cliente configurável para qualquer agente compatível com o contrato. */
export function createAgentChatClient(options: AgentChatClientOptions): AgentChatDriver {
  const endpoints = options.endpoints ?? {}
  let activeChatId = options.visitorKey
  let sessionStarted = false
  let sessionPromise: Promise<ChatSession> | undefined
  let pending: AgentChatOutboxEntry[] = []
  let sequence = 0

  const buildSessionBody = endpoints.buildSessionBody ?? ((input: StartChatSessionInput) => input)
  const buildSendBody = endpoints.buildSendBody ?? ((input: SendChatMessageInput) => input)
  const buildVisitBody = endpoints.buildVisitBody ?? ((visitorKey: string, pageUrl: string) => ({ visitorKey, pageUrl }))

  async function startSession(): Promise<ChatSession> {
    if (sessionStarted) {
      return { chatId: activeChatId, existing: true }
    }
    if (sessionPromise) return sessionPromise

    const input: StartChatSessionInput = {
      visitorKey: options.visitorKey,
      agentId: options.agentId,
    }
    sessionPromise = (async () => {
      const data = await options.http.request<unknown>("POST", endpoints.sessionPath ?? DEFAULT_SESSION_PATH, {
        body: buildSessionBody(input),
        auth: "none",
      })
      const result = data as { chatId?: unknown; existing?: unknown } | null
      if (!result || typeof result.chatId !== "string" || result.chatId.trim() === "") {
        throw erroRespostaInvalida("A sessão do agente não retornou um chatId")
      }
      activeChatId = result.chatId
      sessionStarted = true
      return {
        chatId: result.chatId,
        ...(typeof result.existing === "boolean" ? { existing: result.existing } : {}),
      }
    })()
    try {
      return await sessionPromise
    } finally {
      sessionPromise = undefined
    }
  }

  async function recordVisit(
    pageUrl = typeof window !== "undefined" ? window.location.href : "",
  ): Promise<boolean> {
    try {
      await options.http.request<unknown>("POST", endpoints.visitPath ?? DEFAULT_VISIT_PATH, {
        body: buildVisitBody(options.visitorKey, pageUrl),
        auth: "none",
      })
      return true
    } catch {
      return false
    }
  }

  async function loadHistory(): Promise<ChatHistory> {
    // Ler o histórico não pode materializar uma sessão. Isso permite que a
    // página seja visitada sem registrar um lead; a sessão só nasce no
    // primeiro contato válido (startSession/sendMessage).
    if (!sessionStarted) {
      return { chatId: activeChatId, messages: [] }
    }
    const path = endpoints.historyPath?.(activeChatId) ?? `/agent-chat/${encodeURIComponent(activeChatId)}/history`
    const data = await options.http.request<unknown>("GET", path, { auth: "none" })
    const result = data as { chatId?: unknown; messages?: unknown }
    const metadata = endpoints.historyMetadata?.(result as Record<string, unknown>)
    const parsed = chatHistorySchema.safeParse({
      chatId: typeof result.chatId === "string" ? result.chatId : activeChatId,
      messages: result.messages,
      ...(metadata ? { metadata } : {}),
    })
    if (!parsed.success) throw erroRespostaInvalida("O histórico do agente não segue o contrato esperado", parsed.error)
    if (parsed.data.chatId !== activeChatId) activeChatId = parsed.data.chatId
    return parsed.data
  }

  function enqueue(input: SendChatMessageInput): void {
    pending = [...pending, { id: ++sequence, input, queuedAt: new Date().toISOString() }]
  }

  async function sendRaw(input: SendChatMessageInput): Promise<SendChatMessageResult> {
    try {
      const data = await options.http.request<unknown>("POST", endpoints.sendPath ?? DEFAULT_SEND_PATH, {
        body: buildSendBody(input),
        auth: "none",
      })
      const result = data as Record<string, unknown> | null
      if (result && result.ok === false) {
        const reason = result.reason
        if (reason === "offline" || reason === "http_error" || reason === "aborted") {
          return {
            ok: false,
            reason,
            retryable: result.retryable === true,
          }
        }
      }
      if (result && (result.messageId !== undefined || result.chatId !== undefined)) {
        return {
          ok: true,
          ...(typeof result.messageId === "string" ? { messageId: result.messageId } : {}),
          ...(typeof result.chatId === "string" ? { chatId: result.chatId } : {}),
        }
      }
      return { ok: true }
    } catch (error: unknown) {
      if (error instanceof ApiClientError) {
        return { ok: false, reason: "http_error", retryable: error.status >= 500 }
      }
      return { ok: false, reason: "offline", retryable: true }
    }
  }

  async function sendMessage(text: string, attachments: ChatAttachment[] = []): Promise<SendChatMessageResult> {
    // O envio é o primeiro ponto que representa contato real do visitante.
    // A promessa compartilhada também evita duas sessões em envios rápidos.
    if (!sessionStarted) {
      try {
        await startSession()
      } catch (error: unknown) {
        // Erro de transporte na sessão: enfileira a mensagem para reenvio posterior
        const input: SendChatMessageInput = {
          chatId: activeChatId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        }
        if (error instanceof ApiClientError) {
          return { ok: false, reason: "http_error", retryable: error.status >= 500 }
        }
        enqueue(input)
        return { ok: false, reason: "offline", retryable: true }
      }
    }
    const input: SendChatMessageInput = {
      chatId: activeChatId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    }
    if (pending.length > 0) {
      enqueue(input)
      return { ok: false, reason: "offline", retryable: true }
    }
    const result = await sendRaw(input)
    if (!result.ok && result.reason === "offline") enqueue(input)
    if (result.ok && result.chatId) activeChatId = result.chatId
    return result
  }

  async function flushOutbox(): Promise<number> {
    let sent = 0
    for (const entry of [...pending]) {
      const result = await sendRaw({ ...entry.input, chatId: activeChatId })
      if (!result.ok) break
      pending = pending.filter((item) => item.id !== entry.id)
      if (result.chatId) activeChatId = result.chatId
      sent += 1
    }
    return sent
  }

  return {
    get chatId() { return activeChatId },
    visitorKey: options.visitorKey,
    startSession,
    recordVisit,
    loadHistory,
    sendMessage,
    get outbox() { return pending },
    flushOutbox,
  }
}
