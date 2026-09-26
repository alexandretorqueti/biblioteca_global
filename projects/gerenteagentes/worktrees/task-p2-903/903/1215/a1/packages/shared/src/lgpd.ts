import { z } from "zod"
import { perfilSchema, type Perfil } from "./auth"

const dataIsoSchema = z.string().datetime({ offset: true })

/** Dados enviados para registrar o aceite da política de privacidade. */
export const consentimentoRequestSchema = z
  .object({
    usuario_id: z.number().int().positive(),
    versao_politica: z.string().trim().min(1).max(50),
    ip: z.string().trim().min(1).max(45),
  })
  .strict()

export type ConsentimentoRequest = z.infer<typeof consentimentoRequestSchema>

export const consentimentoResponseSchema = z
  .object({
    id: z.number().int().positive(),
    usuario_id: z.number().int().positive(),
    data: dataIsoSchema,
    versao_politica: z.string().trim().min(1).max(50),
    ip: z.string().trim().min(1).max(45).nullable(),
  })
  .strict()

export type ConsentimentoResponse = z.infer<typeof consentimentoResponseSchema>

export const consentimentoStatusSchema = z
  .object({
    aceito: z.boolean(),
    versao_politica: z.string().nullable(),
    data: dataIsoSchema.nullable(),
  })
  .strict()

export type ConsentimentoStatus = z.infer<typeof consentimentoStatusSchema>

export interface UsuarioConsentimento {
  id: number
  usuario_id: number
  data: string
  versao_politica: string
  ip: string | null
}

export interface UsuarioVinculoExport {
  projetoId: number
  projetoNome: string
  projetoSlug: string
  perfil: Perfil
  createdAt: string
}

/** Representação portátil de todos os dados pessoais do usuário. */
export interface UsuarioDadosExport {
  id: number
  username: string | null
  email: string | null
  telefone: string | null
  cpf: string | null
  nome: string
  ativo: boolean
  createdAt: string
  updatedAt: string
  consentimentos: UsuarioConsentimento[]
  vinculos: UsuarioVinculoExport[]
}

export const usuarioConsentimentoSchema = z
  .object({
    id: z.number().int().positive(),
    usuario_id: z.number().int().positive(),
    data: dataIsoSchema,
    versao_politica: z.string().trim().min(1).max(50),
    ip: z.string().trim().min(1).max(45).nullable(),
  })
  .strict()

export const usuarioVinculoExportSchema = z
  .object({
    projetoId: z.number().int().positive(),
    projetoNome: z.string(),
    projetoSlug: z.string(),
    perfil: perfilSchema,
    createdAt: dataIsoSchema,
  })
  .strict()

export const usuarioDadosExportSchema = z
  .object({
    id: z.number().int().positive(),
    username: z.string().nullable(),
    email: z.string().email().nullable(),
    telefone: z.string().nullable(),
    cpf: z.string().nullable(),
    nome: z.string(),
    ativo: z.boolean(),
    createdAt: dataIsoSchema,
    updatedAt: dataIsoSchema,
    consentimentos: z.array(usuarioConsentimentoSchema),
    vinculos: z.array(usuarioVinculoExportSchema),
  })
  .strict()

export const dadosExportResponseSchema = z
  .object({ dados: usuarioDadosExportSchema })
  .strict()

export type DadosExportResponse = z.infer<typeof dadosExportResponseSchema>

/** Campos pessoais permitidos na retificação pelo titular. */
export const retificacaoRequestSchema = z
  .object({
    nome: z.string().trim().min(1).max(150).optional(),
    email: z.string().email().optional(),
    telefone: z.string().trim().min(1).max(30).optional(),
  })
  .strict()
  .refine((dados) => Object.keys(dados).length > 0, {
    message: "Informe ao menos um campo para retificação",
  })

export type RetificacaoRequest = z.infer<typeof retificacaoRequestSchema>

export const exclusaoResponseSchema = z
  .object({
    ok: z.literal(true),
    usuario_id: z.number().int().positive(),
    excluido_em: dataIsoSchema,
  })
  .strict()

export type ExclusaoResponse = z.infer<typeof exclusaoResponseSchema>
