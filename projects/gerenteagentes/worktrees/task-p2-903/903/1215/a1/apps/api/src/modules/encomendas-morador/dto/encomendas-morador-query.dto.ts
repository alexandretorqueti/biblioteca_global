/**
 * DTO de query para listagem de encomendas do morador.
 *
 * Parâmetros opcionais:
 * - status: filtra por status específico (pendente, pronta_retirada, entregue, cancelada)
 * - grupo: filtra por grupo de status (aguardando, prontas, historico)
 * - limit: limite de resultados (default 50, max 200)
 * - offset: offset para paginação (default 0)
 *
 * Grupos de status:
 * - aguardando: pendente (aguardando confirmação do morador)
 * - prontas: pronta_retirada (morador confirmou, aguardando retirada física)
 * - historico: entregue + cancelada (encerradas)
 */
import { z } from "zod"

export const encomendasMoradorQuerySchema = z
  .object({
    status: z
      .enum(["pendente", "pronta_retirada", "entregue", "cancelada"])
      .optional(),
    grupo: z.enum(["aguardando", "prontas", "historico"]).optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict()

export type EncomendasMoradorQuery = z.infer<typeof encomendasMoradorQuerySchema>

/** Tipo de status de encomenda. */
export type StatusEncomenda = "pendente" | "pronta_retirada" | "entregue" | "cancelada"

/** Mapeia grupo para lista de status. */
export function grupoParaStatus(grupo: "aguardando" | "prontas" | "historico"): StatusEncomenda[] {
  switch (grupo) {
    case "aguardando":
      return ["pendente"]
    case "prontas":
      return ["pronta_retirada"]
    case "historico":
      return ["entregue", "cancelada"]
  }
}
