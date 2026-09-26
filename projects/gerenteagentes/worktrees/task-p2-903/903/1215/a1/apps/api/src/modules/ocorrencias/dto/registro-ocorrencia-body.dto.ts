/**
 * DTO para registro de ocorrência/devolução de encomenda.
 *
 * Validações:
 * - encomendaId: obrigatório, deve pertencer ao condomínio do contexto
 * - tipo: enum padronizado (devolucao_transportadora, extravio, recusada, endereco_incorreto, outro)
 * - motivo: obrigatório, mínimo 10 caracteres
 * - descricao: obrigatória quando tipo = 'outro'
 * - fotoEvidenciaUrl: opcional, mas recomendada para certos tipos
 * - observacoes: opcional
 * - devolvidaTransportadora: boolean, default false
 * - dataOcorrencia: opcional, default now()
 */
import { z } from "zod"

export const tiposOcorrencia = [
  "devolucao_transportadora",
  "extravio",
  "recusada",
  "endereco_incorreto",
  "outro",
] as const

export type TipoOcorrencia = (typeof tiposOcorrencia)[number]

export const registroOcorrenciaBodySchema = z
  .object({
    encomendaId: z.number().int().positive(),
    tipo: z.enum(tiposOcorrencia),
    motivo: z.string().min(10, "Motivo deve ter no mínimo 10 caracteres").max(2000),
    descricao: z.string().max(5000).optional(),
    fotoEvidenciaUrl: z.string().url().max(1000).optional().nullable(),
    observacoes: z.string().max(5000).optional(),
    devolvidaTransportadora: z.boolean().default(false),
    dataOcorrencia: z.coerce.date().optional(),
  })
  .refine(
    (data) => {
      // Descrição é obrigatória quando tipo = 'outro'
      if (data.tipo === "outro") {
        return data.descricao && data.descricao.trim().length >= 10
      }
      return true
    },
    {
      message: "Descrição é obrigatória quando tipo for 'Outro' (mínimo 10 caracteres)",
      path: ["descricao"],
    },
  )

export type RegistroOcorrenciaBody = z.infer<typeof registroOcorrenciaBodySchema>
