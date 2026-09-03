/**
 * DTO de query para busca de transportadoras no registro rápido.
 *
 * Critérios:
 * - q: busca textual em nome e cnpj
 * - limit: máximo de resultados (default 20, max 50)
 *
 * A recorrência (frequência de uso no condomínio) é calculada pelo service
 * com base nas encomendas recentes do condomínio do token.
 */
import { z } from "zod"

export const buscaTransportadorasQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    limit: z
      .string()
      .transform((v) => Number(v))
      .pipe(z.number().int().min(1).max(50))
      .optional()
      .default(20),
  })
  .strict()

export type BuscaTransportadorasQuery = z.infer<typeof buscaTransportadorasQuerySchema>
