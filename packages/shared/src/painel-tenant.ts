import { z } from "zod"
import { tenantChatConfigInputSchema, tenantChatConfigSchema, type TenantChatConfig } from "./tenant"
import { transbordoConfigSchema, type TransbordoConfig } from "./transbordo"

const dateTime = z.string().datetime({ offset: true })
const periodo = z.object({ de: dateTime.optional(), ate: dateTime.optional() }).strict()
  .superRefine((value, ctx) => {
    if (value.de && value.ate && value.de > value.ate) {
      ctx.addIssue({ code: "custom", path: ["ate"], message: "ate deve ser posterior ou igual a de" })
    }
  })

export const tenantConversaCanalSchema = z.enum(["web", "whatsapp"])
export const tenantConversaStatusSchema = z.enum(["ativa", "finalizada", "transbordada"])

export const tenantConversasFiltrosSchema = z.object({
  busca: z.string().trim().min(1).optional(),
  canal: tenantConversaCanalSchema.optional(),
  status: tenantConversaStatusSchema.optional(),
  periodo: periodo.optional(),
  pagina: z.number().int().min(1).default(1),
  tamanho: z.number().int().min(1).max(100).default(20),
}).strict()
export type TenantConversasFiltros = z.infer<typeof tenantConversasFiltrosSchema>
export const filtrosConversasSchema = tenantConversasFiltrosSchema

export const tenantConversaItemSchema = z.object({
  id: z.number().int().positive(),
  externalId: z.string().min(1),
  canal: tenantConversaCanalSchema,
  visitanteKey: z.string().min(1),
  contatoNome: z.string().nullable(),
  contatoEmail: z.string().email().nullable(),
  tema: z.string().nullable(),
  status: tenantConversaStatusSchema,
  primeiraMensagemEm: dateTime,
  ultimaMensagemEm: dateTime,
  createdAt: dateTime,
  updatedAt: dateTime,
}).strict()
export type TenantConversaItem = z.infer<typeof tenantConversaItemSchema>

export const tenantConversaMensagemSchema = z.object({
  id: z.number().int().positive(),
  role: z.enum(["visitante", "agente", "sistema"]),
  texto: z.string(),
  criadaEm: dateTime,
}).strict()
export type TenantConversaMensagem = z.infer<typeof tenantConversaMensagemSchema>

export const tenantConversaHistoricoSchema = z.object({
  conversa: tenantConversaItemSchema,
  mensagens: z.array(tenantConversaMensagemSchema),
}).strict()
export type TenantConversaHistorico = z.infer<typeof tenantConversaHistoricoSchema>

export const tenantLeadsFiltrosSchema = z.object({
  busca: z.string().trim().min(1).optional(),
  ferramenta: z.string().trim().min(1).max(100).optional(),
  periodo: periodo.optional(),
  pagina: z.number().int().min(1).default(1),
  tamanho: z.number().int().min(1).max(100).default(20),
}).strict()
export type TenantLeadsFiltros = z.infer<typeof tenantLeadsFiltrosSchema>

export const tenantLeadItemSchema = z.object({
  id: z.number().int().positive(),
  conversaId: z.number().int().positive().nullable(),
  ferramenta: z.string().trim().min(1).max(100),
  dadosJson: z.record(z.string(), z.unknown()),
  externalId: z.string().min(1).nullable(),
  criadoEm: dateTime,
}).strict()
export type TenantLeadItem = z.infer<typeof tenantLeadItemSchema>

export const tenantMetricasSchema = z.object({
  conversasNoMes: z.number().int().nonnegative(),
  tempoMedioRespostaSegundos: z.number().nonnegative().nullable(),
  temasFrequentes: z.array(z.object({ tema: z.string().min(1), quantidade: z.number().int().positive() }).strict()).max(5),
  cota: z.object({
    planoSlug: z.string().trim().min(1),
    limiteConversasPorMes: z.number().int().positive().nullable(),
    usado: z.number().int().nonnegative(),
    percentual: z.number().nonnegative(),
    estourada: z.boolean(),
  }).strict(),
}).strict()
export type TenantMetricas = z.infer<typeof tenantMetricasSchema>
export const metricasTenantSchema = tenantMetricasSchema

export const tenantToolAdminSchema = z.object({
  toolKey: z.string().trim().min(1).max(100),
  params: z.record(z.string(), z.unknown()).nullable(),
  ativo: z.boolean(),
}).strict()

export const tenantConfigAdminViewSchema = z.object({
  configJson: tenantChatConfigSchema,
  ferramentas: z.array(tenantToolAdminSchema),
  transbordo: transbordoConfigSchema.nullable(),
  retencaoConversasDias: z.number().int().positive().nullable(),
}).strict()
export type TenantConfigAdminView = z.infer<typeof tenantConfigAdminViewSchema>

export const tenantConfigAdminInputSchema = z.object({
  configJson: tenantChatConfigInputSchema,
  ferramentas: z.array(tenantToolAdminSchema).optional(),
  transbordo: transbordoConfigSchema.nullable().optional(),
  retencaoConversasDias: z.number().int().positive().nullable().optional(),
}).strict()
export type TenantConfigAdminInput = z.infer<typeof tenantConfigAdminInputSchema>

export const tenantConversaMensagemIngestaoSchema = z.object({
  role: z.enum(["visitante", "agente", "sistema"]),
  texto: z.string(),
  criadaEm: dateTime,
}).strict()

export const tenantConversaIngestaoSchema = z.object({
  externalId: z.string().trim().min(1).max(255),
  canal: tenantConversaCanalSchema,
  visitanteKey: z.string().trim().min(1).max(255),
  contatoNome: z.string().trim().min(1).max(255).optional(),
  contatoEmail: z.string().email().optional(),
  tema: z.string().trim().min(1).max(255).nullable().optional(),
  status: tenantConversaStatusSchema,
  mensagens: z.array(tenantConversaMensagemIngestaoSchema).min(1),
}).strict()
export type TenantConversaIngestao = z.infer<typeof tenantConversaIngestaoSchema>

export const tenantLeadIngestaoSchema = z.object({
  conversaExternalId: z.string().trim().min(1).max(255).optional(),
  ferramenta: z.string().trim().min(1).max(100),
  dadosJson: z.record(z.string(), z.unknown()),
  externalId: z.string().trim().min(1).max(255).nullable().optional(),
  criadoEm: dateTime.optional(),
}).strict()
export type TenantLeadIngestao = z.infer<typeof tenantLeadIngestaoSchema>

export type TenantChatConfigAdmin = TenantChatConfig
export type TenantTransbordoAdmin = TransbordoConfig
