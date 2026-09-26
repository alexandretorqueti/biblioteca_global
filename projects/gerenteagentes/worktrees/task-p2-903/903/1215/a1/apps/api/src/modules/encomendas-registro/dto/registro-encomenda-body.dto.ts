/**
 * DTO do body para registro rápido de encomenda.
 *
 * Campos obrigatórios:
 * - unidadeId: vínculo exclusivo com a unidade do condomínio
 * - registradoPorId: funcionário que está registrando (do condomínio)
 *
 * Campos opcionais:
 * - transportadoraId: transportadora/loja de origem
 * - codigoRastreamento: código de barras/QR escaneado ou digitado
 * - fotoUrl: URL da foto capturada (evidência de chegada)
 * - observacoes: texto livre sobre a encomenda
 *
 * Validações:
 * - unidadeId e registradoPorId são validados pelo service contra o
 *   condomínio do token (impede vínculo cruzado entre condomínios).
 * - fotoUrl é opcional mas recomendada; o service registra exceção se
 *   ausente (contrato permite registro sem foto em casos excepcionais).
 */
import { z } from "zod"

export const registroEncomendaBodySchema = z
  .object({
    unidadeId: z.number().int().positive(),
    transportadoraId: z.number().int().positive().nullable().optional(),
    registradoPorId: z.number().int().positive(),
    codigoRastreamento: z.string().max(100).nullable().optional(),
    fotoUrl: z.string().max(1000).nullable().optional(),
    observacoes: z.string().max(2000).nullable().optional(),
  })
  .strict()

export type RegistroEncomendaBody = z.infer<typeof registroEncomendaBodySchema>
