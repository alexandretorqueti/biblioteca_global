/**
 * DTO de query para listagem de encomendas no painel da portaria.
 *
 * Filtros aceitos (todos opcionais):
 * - estado: estado operacional (aguardando_confirmacao | pronta_retirada | excecoes | todas)
 * - transportadoraId: filtro por transportadora/loja
 * - localizacao: filtro textual na identificação da unidade (label, rua, bloco, numero, quadra, lote)
 * - periodoInicio: data inicial do filtro (ISO 8601)
 * - periodoFim: data final do filtro (ISO 8601)
 * - busca: texto livre para busca por código de rastreamento, ID ou label da unidade
 * - limit: máximo de resultados (default 50, max 200)
 * - offset: paginação (default 0)
 *
 * Estados operacionais:
 * - aguardando_confirmacao: status = pendente (aguarda morador confirmar)
 * - pronta_retirada: status = confirmada (morador confirmou, aguarda retirada física)
 * - excecoes: status = cancelada OU pendente com mais de 3 dias (pendências antigas)
 * - todas: sem filtro de estado (exclui entregues por padrão — usar periodo para incluir)
 */
import { z } from "zod"

export const estadoOperacionalEnum = z.enum([
  "aguardando_confirmacao",
  "pronta_retirada",
  "excecoes",
  "todas",
])

export const painelPortariaQuerySchema = z
  .object({
    estado: estadoOperacionalEnum.optional().default("todas"),
    transportadoraId: z
      .string()
      .transform((v) => Number(v))
      .pipe(z.number().int().positive())
      .optional(),
    localizacao: z.string().max(300).optional(),
    periodoInicio: z.string().datetime({ offset: true }).optional(),
    periodoFim: z.string().datetime({ offset: true }).optional(),
    busca: z.string().max(200).optional(),
    limit: z
      .string()
      .transform((v) => Number(v))
      .pipe(z.number().int().min(1).max(200))
      .optional()
      .default(50),
    offset: z
      .string()
      .transform((v) => Number(v))
      .pipe(z.number().int().min(0))
      .optional()
      .default(0),
  })
  .strict()

export type PainelPortariaQueryInput = z.input<typeof painelPortariaQuerySchema>
export type PainelPortariaQuery = z.output<typeof painelPortariaQuerySchema>
