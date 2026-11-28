/**
 * Contrato público da vitrine (macro #10, posição 2/11 — subtarefa 1).
 *
 * Zod-first: é a forma EXATA da resposta de `GET /api/vitrine/conteudo`
 * (endpoint público read-only, sem autenticação). A API serializa por
 * allow-list e valida contra este schema antes de responder; o front da
 * vitrine consome exclusivamente estes tipos.
 *
 * Regras de exposição (ESPEC-CRUD §observações / REQ-F-001):
 * - somente as 5 tabelas de conteúdo (planos, itens_faq, metricas_destaque,
 *   segmentos, textos_vitrine), somente linhas `ativo = true`;
 * - NENHUM campo interno (id, ativo, ordem, pedidos, documentos,
 *   integracoes_externas/credenciaisCifradas, agentes_provisionados,
 *   configuracoes_whatsapp) faz parte do contrato — os objetos são
 *   `.strict()`, então chave não listada reprova o parse em qualquer ponta;
 * - `textos` inclui a chave `whatsapp_link` (WhatsApp centralizado — RF-9).
 */
import { z } from "zod"

/** Seções editáveis de texto — espelha o enum `secao` de textos_vitrine (schema.ts). */
export const vitrinePublicaSecaoSchema = z.enum([
  "hero",
  "dores",
  "beneficios",
  "como_funciona",
  "cta",
  "contato",
])
export type VitrinePublicaSecao = z.infer<typeof vitrinePublicaSecaoSchema>

/** Texto livre da vitrine por chave única (hero_titulo, whatsapp_link…). */
export const vitrinePublicaTextoSchema = z
  .object({
    chave: z.string().min(1),
    secao: vitrinePublicaSecaoSchema.nullable(),
    conteudo: z.string(),
  })
  .strict()
export type VitrinePublicaTexto = z.infer<typeof vitrinePublicaTextoSchema>

/** Plano comercial exibido no card da vitrine (sem id — seleção é por nome). */
export const vitrinePublicaPlanoSchema = z
  .object({
    nome: z.string().min(1),
    tagline: z.string().nullable(),
    precoMensal: z.number(),
    precoSetup: z.number().nullable(),
    beneficios: z.array(z.string()),
    textoBotao: z.string().nullable(),
    maisPopular: z.boolean(),
  })
  .strict()
export type VitrinePublicaPlano = z.infer<typeof vitrinePublicaPlanoSchema>

/** Par pergunta/resposta do FAQ. */
export const vitrinePublicaFaqSchema = z
  .object({
    pergunta: z.string().min(1),
    resposta: z.string(),
  })
  .strict()
export type VitrinePublicaFaq = z.infer<typeof vitrinePublicaFaqSchema>

/** Métrica de destaque (ex.: "24/7"). */
export const vitrinePublicaMetricaSchema = z
  .object({
    valor: z.string().min(1),
    rotulo: z.string().nullable(),
  })
  .strict()
export type VitrinePublicaMetrica = z.infer<typeof vitrinePublicaMetricaSchema>

/** Card de segmento de atendimento. */
export const vitrinePublicaSegmentoSchema = z
  .object({
    titulo: z.string().min(1),
    descricao: z.string().nullable(),
    icone: z.string().nullable(),
  })
  .strict()
export type VitrinePublicaSegmento = z.infer<typeof vitrinePublicaSegmentoSchema>

/** Resposta agregada de `GET /api/vitrine/conteudo` (somente conteúdo ativo). */
export const vitrinePublicaConteudoSchema = z
  .object({
    textos: z.array(vitrinePublicaTextoSchema),
    planos: z.array(vitrinePublicaPlanoSchema),
    metricas: z.array(vitrinePublicaMetricaSchema),
    faq: z.array(vitrinePublicaFaqSchema),
    segmentos: z.array(vitrinePublicaSegmentoSchema),
  })
  .strict()
export type VitrinePublicaConteudo = z.infer<typeof vitrinePublicaConteudoSchema>
