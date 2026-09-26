/**
 * Tipos e interfaces do módulo Isa Chat.
 *
 * A ponte (bridge) é o ÚNICO ponto que conhece o OpenClaw/BFF.
 * O service orquestra a lógica de negócio sem saber detalhes de transporte.
 */

/** Sessão de agente do OpenClaw (sessionKey), ex.: "agent:isa:xyz". */
export interface AgentSession {
  readonly sessionKey: string
  readonly sessionId?: string
}

/** Resultado do envio de uma mensagem à sessão do agente. */
export interface BridgeSendResult {
  readonly ok: boolean
  readonly messageId?: string
  readonly retryable: boolean
}

export interface ResolvedSession {
  readonly sessionKey: string
  readonly existing: boolean
  readonly sessionId?: string
}

/**
 * Contrato interno da ponte com o OpenClaw.
 * A implementação (isa-chat.bridge.ts) é o único lugar que conhece o BFF.
 */
export interface IsaChatBridge {
  resolveSession(input: {
    agentId: string
    chatKey: string
  }): Promise<ResolvedSession>

  send(input: {
    sessionKey: string
    text: string
    attachments?: ReadonlyArray<{ name: string; size?: string }>
  }): Promise<BridgeSendResult>

  abort(input: { sessionKey: string }): Promise<void>

  history(input: {
    sessionKey: string
    limit?: number
    offset?: number
  }): Promise<Array<{ role: "agent" | "user" | "system"; text?: string | null }>>

  renameSession(input: {
    sessionKey: string
    agentId: string
    label: string
  }): Promise<void>
}

/** Configuração da ponte (lida via ConfigService). */
export interface IsaChatBridgeConfig {
  baseUrl: string
  token?: string
  timeoutMs?: number
}

/** Entrada para criação de sessão (anônima ou legado). */
export interface CreateSessionInput {
  chatKey?: string
  email?: string
  nome?: string
  agentId?: string
}

/** Resultado da criação/recuperação de sessão. */
export interface SessionResult {
  ok: boolean
  chatId: string
  existing: boolean
  onboarding?: OnboardingState
  contactId?: number
}

/** Estado do onboarding (para o front). */
export interface OnboardingState {
  state: string
  verified: boolean
  name?: string | null
  email?: string | null
  phone?: string | null
}

/** Entrada para envio de mensagem. */
export interface SendMessageInput {
  chatId: string
  text: string
  agentId?: string
  attachments?: ReadonlyArray<{
    name: string
    size?: string
    mime?: string
    base64?: string
  }>
}

/** Resultado do envio de mensagem. */
export type SendMessageResult =
  | { ok: true; messageId?: string }
  | { ok: false; reason: "offline" | "http_error" | "aborted" | "chat_not_found" | "unavailable"; retryable: boolean }

/** Registro de mensagem no histórico. */
export interface ChatMessageRecord {
  id: string
  role: "user" | "agent" | "system"
  text: string | null
  createdAt: Date
}

/** Histórico completo retornado ao front. */
export interface ChatHistoryResult {
  ok: boolean
  chatId: string
  messages: ChatMessageRecord[]
  project: {
    name: string | null
    definitions: Array<{ id: string; definition: string; createdAt: string }>
  }
  onboarding: OnboardingState
}

/** Entrada para registro de visita. */
export interface SiteVisitInput {
  visitorKey?: string
  pageUrl?: string
  referrer?: string
  userAgent?: string
  remoteIp?: string
}

/** Resultado do registro/atualização de definição. */
export type DefinitionResult =
  | { ok: true; id: string }
  | { ok: false; reason: "chat_not_found" | "not_verified" | "definition_not_found" }

/** Resultado do nome do projeto. */
export type ProjectNameResult =
  | { ok: true; chatId: string }
  | { ok: false; reason: "chat_not_found" }

/** Resultado do fechamento da captação. */
export type FinalizeResult =
  | { ok: true; chatId: string; projetoId?: string; slug?: string }
  | {
      ok: false
      chatId: string
      reason: "chat_not_found" | "not_verified" | "project_name_required" | "no_definitions"
    }
