/**
 * DTO do body para registro de entrega no painel da portaria.
 *
 * Campos obrigatórios:
 * - funcionarioId: funcionário que está registrando a entrega (do condomínio)
 * - recebedorNome: nome completo de quem retirou a encomenda
 *
 * Campos opcionais:
 * - recebedorDocumento: documento de identificação de quem retirou
 * - recebedorVinculo: relação com o morador (próprio, familiar, empregado, terceiro)
 * - fotoComprovanteUrl: URL da foto do comprovante de retirada
 * - observacoesEntrega: observações sobre a entrega
 *
 * Validações:
 * - O service valida que funcionarioId pertence ao condomínio do token
 * - A encomenda deve estar com status = confirmada
 * - recebedorNome é obrigatório (evidência mínima de quem retirou)
 */
import { z } from "zod"

export const entregaBodySchema = z
  .object({
    funcionarioId: z.number().int().positive(),
    recebedorNome: z.string().min(3).max(200),
    recebedorDocumento: z.string().max(30).nullable().optional(),
    recebedorVinculo: z
      .enum(["proprio_morador", "familiar", "empregado", "terceiro"])
      .nullable()
      .optional(),
    fotoComprovanteUrl: z.string().max(1000).nullable().optional(),
    observacoesEntrega: z.string().max(1000).nullable().optional(),
  })
  .strict()

export type EntregaBody = z.infer<typeof entregaBodySchema>
