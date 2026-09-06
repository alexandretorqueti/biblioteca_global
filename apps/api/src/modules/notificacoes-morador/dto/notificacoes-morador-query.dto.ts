/**
 * DTO de query para listagem de notificações do morador.
 *
 * Parâmetros opcionais:
 * - apenasNaoLidas: se true, retorna apenas notificações não lidas
 * - limit: limite de resultados (default 50, max 200)
 * - offset: offset para paginação (default 0)
 */
import { z } from "zod"

export const notificacoesMoradorQuerySchema = z
  .object({
    apenasNaoLidas: z
      .union([z.boolean(), z.string().transform((v) => v === "true" || v === "1")])
      .optional()
      .default(false),
    limit: z.coerce.number().int().positive().max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict()

export type NotificacoesMoradorQuery = z.infer<typeof notificacoesMoradorQuerySchema>
