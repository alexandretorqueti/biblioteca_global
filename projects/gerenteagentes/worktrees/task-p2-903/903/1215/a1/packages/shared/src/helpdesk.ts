/** Contratos do HelpDesk persistido no database core. */
import { z } from "zod"
import { chatMessageRoleSchema } from "./chat"

export const helpDeskSessionStatusSchema = z.enum(["active", "closed"])

export const helpDeskSessionSchema = z
  .object({
    id: z.number().int().positive(),
    usuarioId: z.number().int().positive(),
    projetoId: z.number().int().positive(),
    agenteId: z.string().trim().min(1),
    status: helpDeskSessionStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()

export type HelpDeskSession = z.infer<typeof helpDeskSessionSchema>

export const helpDeskMessageSchema = z
  .object({
    id: z.number().int().positive(),
    sessaoId: z.number().int().positive(),
    role: chatMessageRoleSchema,
    text: z.string(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()

export type HelpDeskMessage = z.infer<typeof helpDeskMessageSchema>

export const helpDeskSendMessageInputSchema = z
  .object({
    sessaoId: z.number().int().positive(),
    text: z.string(),
  })
  .strict()

export type HelpDeskSendMessageInput = z.infer<
  typeof helpDeskSendMessageInputSchema
>

export const helpDeskHistorySchema = z
  .object({
    sessao: helpDeskSessionSchema,
    mensagens: z.array(helpDeskMessageSchema),
  })
  .strict()

export type HelpDeskHistory = z.infer<typeof helpDeskHistorySchema>
