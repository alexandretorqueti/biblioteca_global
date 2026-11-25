/**
 * DTOs (Zod) dos endpoints custom de fluxo da tarefa
 * (gestao-de-tarefas-global — macro #3, subtarefa 2).
 *
 * Regras:
 * - `responsavelId`/`autorId`/id de tarefa NUNCA vêm do body quando
 *   deriváveis da sessão: o autor da mensagem é SEMPRE o colaborador da
 *   sessão (guard de escopo), nunca do payload;
 * - `sabor` da devolução: um dos 3 estados pós-delegação;
 * - mensagens não vazias são validadas também pela máquina de estados
 *   (dupla barreira: 400 de formato aqui, 409 de domínio lá).
 */
import { z } from "zod"

export const delegarBodySchema = z
  .object({
    /** Colaborador-alvo (deve ser ativo e da mesma organização — máquina). */
    responsavelId: z.number().int().positive(),
  })
  .strict()
export type DelegarBody = z.infer<typeof delegarBodySchema>

/** Sabores da devolução — espelha FlavDevolucao do domínio (sem import de apps). */
export const saboresDevolucao = [
  "concluida",
  "precisa_informacoes",
  "aguardando_terceiro",
] as const
export type SaborDevolucao = (typeof saboresDevolucao)[number]

export const devolverBodySchema = z
  .object({
    sabor: z.enum(saboresDevolucao),
    /** Obrigatória e não vazia em toda devolução (máquina de estados). */
    mensagem: z.string().min(1),
  })
  .strict()
export type DevolverBody = z.infer<typeof devolverBodySchema>

export const cancelarBodySchema = z
  .object({
    /** Opcional — motivo do cancelamento. */
    motivo: z.string().optional(),
  })
  .strict()
export type CancelarBody = z.infer<typeof cancelarBodySchema>

export const mensagemChatBodySchema = z
  .object({
    /** Texto da mensagem (autor é sempre o colaborador da sessão). */
    texto: z.string().min(1),
  })
  .strict()
export type MensagemChatBody = z.infer<typeof mensagemChatBodySchema>
