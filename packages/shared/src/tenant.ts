import { z } from "zod"

const optionalNonEmptyString = z.string().trim().min(1).optional()

export const tenantChatConfigSchema = z
  .object({
    nome: z.string().trim().min(1),
    persona: z
      .object({ avatarUrl: optionalNonEmptyString, tom: optionalNonEmptyString })
      .strict(),
    paleta: z
      .object({
        primaria: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
        secundaria: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
        fundo: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .strict(),
    textos: z
      .object({
        saudacao: z.string(),
        placeholder: z.string(),
        indisponivel: z.string(),
      })
      .strict(),
    ferramentas: z.array(z.string().trim().min(1)),
    idiomas: z.array(z.string().trim().min(2)).min(1),
    anexos: z
      .object({
        permitido: z.boolean(),
        tipos: z.array(z.string().trim().min(1)),
        maxMb: z.number().positive(),
      })
      .strict(),
    chat: z
      .object({ mostrarIndicadorDigitacao: z.boolean() })
      .strict(),
    lgpd: z
      .object({ aviso: z.string(), politicaUrl: optionalNonEmptyString })
      .strict(),
    tema: z.object({ modo: z.enum(["claro", "escuro"]) }).strict(),
    canais: z.object({ web: z.boolean(), whatsapp: z.boolean() }).strict(),
  })
  .strict()

export type TenantChatConfig = z.infer<typeof tenantChatConfigSchema>

export const DEFAULT_TENANT_CHAT_CONFIG: Omit<TenantChatConfig, "nome"> = {
  persona: {},
  paleta: { primaria: "#2563EB", secundaria: "#0F172A", fundo: "#F8FAFC" },
  textos: {
    saudacao: "Olá! Como posso ajudar?",
    placeholder: "Digite sua mensagem…",
    indisponivel: "No momento, não foi possível responder. Tente novamente.",
  },
  ferramentas: [],
  idiomas: ["pt-BR"],
  anexos: { permitido: false, tipos: [], maxMb: 10 },
  chat: { mostrarIndicadorDigitacao: true },
  lgpd: {
    aviso: "Esta conversa pode ser armazenada para atendimento, conforme a LGPD.",
  },
  tema: { modo: "claro" },
  canais: { web: true, whatsapp: false },
}

export const tenantChatConfigInputSchema = z
  .object({
    nome: z.string().trim().min(1).optional(),
    persona: tenantChatConfigSchema.shape.persona.partial().optional(),
    paleta: tenantChatConfigSchema.shape.paleta.partial().optional(),
    textos: tenantChatConfigSchema.shape.textos.partial().optional(),
    ferramentas: tenantChatConfigSchema.shape.ferramentas.optional(),
    idiomas: tenantChatConfigSchema.shape.idiomas.optional(),
    anexos: tenantChatConfigSchema.shape.anexos.partial().optional(),
    chat: tenantChatConfigSchema.shape.chat.partial().optional(),
    lgpd: tenantChatConfigSchema.shape.lgpd.partial().optional(),
    tema: tenantChatConfigSchema.shape.tema.partial().optional(),
    canais: tenantChatConfigSchema.shape.canais.partial().optional(),
  })
  .strip()

/** Normaliza JSON persistido sem transportar prompt, segredos ou metadados internos. */
export function normalizeTenantChatConfig(input: unknown, nome: string): TenantChatConfig {
  const parsed = tenantChatConfigInputSchema.parse(input ?? {})
  return tenantChatConfigSchema.parse({
    nome: nome.trim() || "Atendente",
    ...DEFAULT_TENANT_CHAT_CONFIG,
    ...parsed,
    persona: { ...DEFAULT_TENANT_CHAT_CONFIG.persona, ...parsed.persona },
    paleta: { ...DEFAULT_TENANT_CHAT_CONFIG.paleta, ...parsed.paleta },
    textos: { ...DEFAULT_TENANT_CHAT_CONFIG.textos, ...parsed.textos },
    anexos: { ...DEFAULT_TENANT_CHAT_CONFIG.anexos, ...parsed.anexos },
    chat: { ...DEFAULT_TENANT_CHAT_CONFIG.chat, ...parsed.chat },
    lgpd: { ...DEFAULT_TENANT_CHAT_CONFIG.lgpd, ...parsed.lgpd },
    tema: { ...DEFAULT_TENANT_CHAT_CONFIG.tema, ...parsed.tema },
    canais: { ...DEFAULT_TENANT_CHAT_CONFIG.canais, ...parsed.canais },
  })
}
