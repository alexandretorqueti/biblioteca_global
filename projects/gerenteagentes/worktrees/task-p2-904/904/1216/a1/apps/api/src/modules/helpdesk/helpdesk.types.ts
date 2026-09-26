/**
 * helpdesk.types.ts — Tipos do módulo HelpDesk.
 */

export interface HelpDeskSessionResult {
  ok: true
  sessaoId: number
  agenteId: string
}

export interface HelpDeskSendMessageInput {
  sessaoId: number
  text: string
}

export interface HelpDeskSendResult {
  ok: boolean
  messageId?: string
  reason?: "offline" | "session_not_found" | "chat_closed"
  retryable?: boolean
}

export interface HelpDeskHistoryResult {
  sessao: {
    id: number
    usuarioId: number
    projetoId: number
    agenteId: string
    status: "active" | "closed"
    createdAt: string
    updatedAt: string
  }
  mensagens: Array<{
    id: number
    sessaoId: number
    role: "agent" | "user" | "system"
    text: string
    createdAt: string
  }>
}

/** Resultado de resolver a cadeia de modelos para um projeto/fase. */
export interface ResolvedModelChain {
  modelo: string
  posicao: number
  isLocal: boolean
}
