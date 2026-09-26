/**
 * DTO do body para reenvio de aviso ao morador.
 *
 * Campos opcionais:
 * - mensagemCustom: mensagem customizada (se omitida, usa template padrão)
 *
 * Aplicável apenas para encomendas com status = pendente ou confirmada.
 * Para entregues ou canceladas, o endpoint retorna erro explicando o motivo.
 */
import { z } from "zod"

export const reenviarAvisoBodySchema = z
  .object({
    mensagemCustom: z.string().max(500).nullable().optional(),
  })
  .strict()

export type ReenviarAvisoBody = z.infer<typeof reenviarAvisoBodySchema>
