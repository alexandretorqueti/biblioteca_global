/**
 * Contratos compartilhados do chat com agentes.
 *
 * A UI recebe estes dados e um cliente já configurado; ela não conhece URLs
 * nem faz transporte HTTP. O mesmo contrato pode ser usado pela Isa ou por
 * qualquer outro agente configurado no sistema.
 */
import { z } from "zod"

/** Identidade pública do agente exibida pelo componente de chat. */
export const agentInfoSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    domain: z.string().trim().min(1).optional(),
    avatarUrl: z.string().trim().min(1).optional(),
  })
  .strict()

export type AgentInfo = z.infer<typeof agentInfoSchema>

/** Papel de uma mensagem persistida na conversa. */
export const chatMessageRoleSchema = z.enum(["agent", "user", "system"])

export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>

/** Anexo enviado pelo visitante ou associado a uma mensagem. */
export const chatAttachmentSchema = z
  .object({
    name: z.string().trim().min(1),
    size: z.string().trim().min(1).optional(),
    mime: z.string().trim().min(1).optional(),
    /** Conteúdo Base64: presente na entrada, normalmente omitido no histórico. */
    base64: z.string().min(1).optional(),
  })
  .strict()

export type ChatAttachment = z.infer<typeof chatAttachmentSchema>

/** Mensagem retornada pelo histórico do agente. */
export const chatMessageSchema = z
  .object({
    id: z.string().trim().min(1),
    role: chatMessageRoleSchema,
    text: z.string(),
    createdAt: z.string().datetime({ offset: true }).optional(),
    attachments: z.array(chatAttachmentSchema.omit({ base64: true })).optional(),
  })
  .strict()

export type ChatMessage = z.infer<typeof chatMessageSchema>

/** Sessão criada ou retomada para uma conversa. */
export const chatSessionSchema = z
  .object({
    chatId: z.string().trim().min(1),
    existing: z.boolean().optional(),
  })
  .strict()

export type ChatSession = z.infer<typeof chatSessionSchema>

/** Entrada usada para iniciar ou retomar uma sessão anônima. */
export const startChatSessionInputSchema = z
  .object({
    visitorKey: z.string().trim().min(1),
    agentId: z.string().trim().min(1),
  })
  .strict()

export type StartChatSessionInput = z.infer<typeof startChatSessionInputSchema>

/** Entrada de envio de uma mensagem ao agente. */
export const sendChatMessageInputSchema = z
  .object({
    chatId: z.string().trim().min(1),
    text: z.string(),
    attachments: z.array(chatAttachmentSchema).optional(),
  })
  .strict()

export type SendChatMessageInput = z.infer<typeof sendChatMessageInputSchema>

/** Histórico completo retornado pelo cliente do agente. */
export const chatHistorySchema = z
  .object({
    chatId: z.string().trim().min(1),
    messages: z.array(chatMessageSchema),
  })
  .strict()

export type ChatHistory = z.infer<typeof chatHistorySchema>

/** Fonte de dados consumida pelo componente visual; não conhece HTTP. */
export interface AgentChatDataSource {
  readonly chatId: string
  readonly visitorKey: string
  startSession(): Promise<ChatSession>
  recordVisit?(pageUrl?: string): Promise<boolean>
  loadHistory(): Promise<ChatHistory>
  sendMessage(text: string, attachments?: ChatAttachment[]): Promise<SendChatMessageResult>
}

/** Resultado bem-sucedido do envio de uma mensagem. */
export const sendChatMessageSuccessSchema = z
  .object({
    ok: z.literal(true),
    messageId: z.string().trim().min(1).optional(),
    chatId: z.string().trim().min(1).optional(),
  })
  .strict()

export type SendChatMessageSuccess = z.infer<typeof sendChatMessageSuccessSchema>

/** Motivo técnico de uma falha de envio. */
export const chatSendFailureReasonSchema = z.enum([
  "offline",
  "http_error",
  "aborted",
])

export type ChatSendFailureReason = z.infer<typeof chatSendFailureReasonSchema>

/** Resultado previsível de uma tentativa de envio. */
export const sendChatMessageFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: chatSendFailureReasonSchema,
    retryable: z.boolean(),
  })
  .strict()

export type SendChatMessageFailure = z.infer<typeof sendChatMessageFailureSchema>

export const sendChatMessageResultSchema = z.discriminatedUnion("ok", [
  sendChatMessageSuccessSchema,
  sendChatMessageFailureSchema,
])

export type SendChatMessageResult = z.infer<typeof sendChatMessageResultSchema>
