/**
 * DTO de query para busca de unidades no registro rápido de encomendas.
 *
 * Critérios aceitos (todos opcionais — busca por qualquer combinação):
 * - q: busca textual em label, rua, bloco, numero, quadra, lote
 * - tipo: filtro por tipo de unidade (apartamento | casa)
 * - ativo: filtro por status (default true)
 * - limit: máximo de resultados (default 20, max 50)
 */
import { z } from "zod"

export const buscaUnidadesQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    tipo: z.enum(["apartamento", "casa"]).optional(),
    ativo: z
      .union([z.boolean(), z.string().transform((v) => v === "true" || v === "1")])
      .optional()
      .default(true),
    limit: z
      .string()
      .transform((v) => Number(v))
      .pipe(z.number().int().min(1).max(50))
      .optional()
      .default(20),
  })
  .strict()

/** Tipo de entrada (antes da transformação). */
export type BuscaUnidadesQueryInput = z.input<typeof buscaUnidadesQuerySchema>
/** Tipo de saída (após a transformação). */
export type BuscaUnidadesQuery = z.output<typeof buscaUnidadesQuerySchema>
