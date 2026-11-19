import { z } from "zod"

export const tenantCanalWhatsappEstadoSchema = z.enum([
  "pareando",
  "ativo",
  "expirado",
  "removido",
])
export type TenantCanalWhatsappEstado = z.infer<typeof tenantCanalWhatsappEstadoSchema>

const accountIdSchema = z.string().trim().min(1).max(100)
const phoneSchema = z.string().regex(/^\d{10,11}$/)

export const tenantCanalWhatsappSchema = z.object({
  id: z.number().int().positive(),
  tenantId: z.number().int().positive(),
  accountId: accountIdSchema,
  numero: phoneSchema.nullable(),
  agentId: z.string().trim().min(1).max(255).nullable(),
  estado: tenantCanalWhatsappEstadoSchema,
  ultimoStatusEm: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict()
export type TenantCanalWhatsapp = z.infer<typeof tenantCanalWhatsappSchema>

export const iniciarPareamentoWhatsappRequestSchema = z.object({
  accountId: accountIdSchema,
}).strict()
export type IniciarPareamentoWhatsappRequest = z.infer<typeof iniciarPareamentoWhatsappRequestSchema>

export const iniciarPareamentoWhatsappResponseSchema = z.object({
  accountId: accountIdSchema,
  qr: z.string().startsWith("data:"),
  expiresAt: z.string().datetime({ offset: true }),
}).strict()
export type IniciarPareamentoWhatsappResponse = z.infer<typeof iniciarPareamentoWhatsappResponseSchema>

export const statusPareamentoWhatsappResponseSchema = z.object({
  accountId: accountIdSchema,
  estado: tenantCanalWhatsappEstadoSchema,
  numero: phoneSchema.nullable(),
  agentId: z.string().trim().min(1).max(255).nullable(),
  ultimoStatusEm: z.string().datetime({ offset: true }).nullable(),
}).strict()
export type StatusPareamentoWhatsappResponse = z.infer<typeof statusPareamentoWhatsappResponseSchema>

export const listarVinculosWhatsappResponseSchema = z.array(tenantCanalWhatsappSchema)
export type ListarVinculosWhatsappResponse = z.infer<typeof listarVinculosWhatsappResponseSchema>

export const removerVinculoWhatsappResponseSchema = z.object({
  ok: z.literal(true),
  accountId: accountIdSchema,
}).strict()
export type RemoverVinculoWhatsappResponse = z.infer<typeof removerVinculoWhatsappResponseSchema>

export const whatsappLoginStartResponseSchema = z.object({
  qr: z.string().startsWith("data:"),
  expiresAt: z.string().datetime({ offset: true }),
}).strict()
export type WhatsappLoginStartResponse = z.infer<typeof whatsappLoginStartResponseSchema>

export const whatsappLoginWaitResponseSchema = z.object({
  status: z.enum(["pending", "paired", "expired", "failed"]),
  phone: phoneSchema.optional(),
}).strict()
export type WhatsappLoginWaitResponse = z.infer<typeof whatsappLoginWaitResponseSchema>

export const whatsappGatewayStatusResponseSchema = z.array(z.object({
  accountId: accountIdSchema,
  connected: z.boolean(),
  phone: phoneSchema.nullable(),
  agentId: z.string().trim().min(1).max(255).optional(),
}).strict())
export type WhatsappGatewayStatusResponse = z.infer<typeof whatsappGatewayStatusResponseSchema>

export const whatsappProvisionRequestSchema = z.object({
  agentId: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(150),
}).strict()
export type WhatsappProvisionRequest = z.infer<typeof whatsappProvisionRequestSchema>

export const whatsappDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict()
export type WhatsappDeleteResponse = z.infer<typeof whatsappDeleteResponseSchema>

/** Retorna somente dígitos e rejeita números que não sejam BR com DDD. */
export function normalizeBrPhone(value: string): string {
  const digits = value.replace(/\D/g, "")
  if (!/^\d{10,11}$/.test(digits)) {
    throw new Error("Telefone BR inválido: informe DDD e número")
  }
  return digits
}

export function isValidBrPhone(value: string): boolean {
  try {
    normalizeBrPhone(value)
    return true
  } catch {
    return false
  }
}

/** Mesmo padrão do emailSlug da Isa, com identidade baseada no telefone. */
export function phoneSlug(value: string): string {
  return `telefone-${normalizeBrPhone(value)}`
}

export const telefoneSlug = phoneSlug
