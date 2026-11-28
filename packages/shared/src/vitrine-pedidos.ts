/**
 * Contratos públicos do pedido da vitrine (macro #10, posição 3/11 —
 * subtarefa 1). Zod-first: são a forma EXATA de
 *   POST /api/vitrine/pedidos   (criação pública, multipart)
 *   GET  /api/vitrine/pedidos/:token (acompanhamento público)
 *
 * Regras (REQ-F-004/REQ-F-015, ESPEC-CRUD §pedidos/documentos):
 * - o backend é a fonte única do pedido: NADA do payload seleciona projeto,
 *   tabela, `planoId` numérico ou `status` — o contrato de criação é
 *   `.strict()`, então chaves de fluxo (`status`, `pagamentoId`,
 *   `linkAgente`, `scriptEmbed`, `id`, `planoId`) são rejeitadas com 400;
 * - `plano` é resolvido POR NOME (o contrato público não conhece ids);
 * - `consentimentoLgpd` é literal `true` — sem aceite não há pedido;
 * - `telefone` usa a regra da plataforma (`isValidBrPhone`, DDD + número);
 * - maxLengths espelham `schema.ts` (nome_negocio/nome_contato/email 160,
 *   telefone 20, plano 120 — nome do plano);
 * - a resposta de criação carrega SOMENTE o token de acompanhamento e dados
 *   de confirmação; a de acompanhamento somente o pedido do cliente
 *   (dados do negócio, nome do plano, ciclo, status, metadados dos
 *   documentos) — `id`, `pagamentoId`, `linkAgente`, `scriptEmbed`,
 *   `caminhoArmazenamento`, `textoExtraido` jamais atravessam (strict).
 */
import { z } from "zod"
import { isValidBrPhone } from "./canais-whatsapp"

/** Ciclo de cobrança — espelha o enum `ciclo` de pedidos (schema.ts). */
export const vitrinePedidoCicloSchema = z.enum(["mensal", "anual"])
export type VitrinePedidoCiclo = z.infer<typeof vitrinePedidoCicloSchema>

/** Status do pedido — espelha o enum `status` de pedidos (exposição read-only). */
export const vitrinePedidoStatusSchema = z.enum([
  "criado",
  "aguardando_pagamento",
  "pago",
  "provisionando",
  "entregue",
  "falha",
])
export type VitrinePedidoStatus = z.infer<typeof vitrinePedidoStatusSchema>

/** Tipo de conteúdo de documento — espelha o enum `tipo_conteudo` (schema.ts). */
export const vitrineDocumentoTipoConteudoSchema = z.enum([
  "pdf",
  "docx",
  "txt",
  "texto_livre",
])
export type VitrineDocumentoTipoConteudo = z.infer<
  typeof vitrineDocumentoTipoConteudoSchema
>

/**
 * Corpo do campo `dados` no multipart de criação (JSON). Estrito: chaves de
 * fluxo/internos (status, pagamentoId, linkAgente, scriptEmbed, id, planoId)
 * NÃO existem aqui — presentes, o parse reprova (400).
 */
export const vitrinePedidoDadosSchema = z
  .object({
    nomeNegocio: z
      .string()
      .trim()
      .min(1, "Informe o nome do negócio")
      .max(160, "Nome do negócio deve ter no máximo 160 caracteres"),
    nomeContato: z
      .string()
      .trim()
      .min(1, "Informe o nome do contato")
      .max(160, "Nome do contato deve ter no máximo 160 caracteres"),
    email: z
      .string()
      .trim()
      .email("E-mail inválido")
      .max(160, "E-mail deve ter no máximo 160 caracteres"),
    telefone: z
      .string()
      .trim()
      .min(1, "Informe o telefone")
      .max(20, "Telefone deve ter no máximo 20 caracteres")
      .refine(isValidBrPhone, "Telefone BR inválido: informe DDD e número"),
    /** Nome do plano (o contrato público não expõe ids). */
    plano: z
      .string()
      .trim()
      .min(1, "Selecione um plano")
      .max(120, "Nome do plano deve ter no máximo 120 caracteres"),
    ciclo: vitrinePedidoCicloSchema,
    /** `text` no schema — sem maxLength; trim defensivo. */
    informacoesNegocio: z.string().trim().max(50_000).optional(),
    consentimentoLgpd: z.literal(true, {
      error: "O consentimento LGPD é obrigatório para enviar o pedido",
    }),
  })
  .strict()
export type VitrinePedidoDados = z.infer<typeof vitrinePedidoDadosSchema>

/**
 * Limite do texto livre enviado no formulário (campo `textoLivre` do
 * multipart). Vira documento `texto_livre` com o texto gravado no banco.
 */
export const VITRINE_TEXTO_LIVRE_MAX_CHARS = 50_000

export const vitrinePedidoTextoLivreSchema = z
  .string()
  .trim()
  .max(
    VITRINE_TEXTO_LIVRE_MAX_CHARS,
    `Texto livre deve ter no máximo ${VITRINE_TEXTO_LIVRE_MAX_CHARS} caracteres`,
  )

/** Token de acompanhamento: 32 bytes aleatórios em hex (64 caracteres). */
export const VITRINE_TOKEN_ACOMPANHAMENTO_REGEX = /^[0-9a-f]{64}$/

/** Resposta de POST /api/vitrine/pedidos — somente token + confirmação. */
export const vitrinePedidoCriacaoRespostaSchema = z
  .object({
    /** Único meio de acompanhar o pedido (nunca o id interno). */
    tokenAcompanhamento: z
      .string()
      .regex(
        VITRINE_TOKEN_ACOMPANHAMENTO_REGEX,
        "Token de acompanhamento malformado",
      ),
    status: z.literal("criado"),
    criadoEm: z.string().min(1),
    mensagem: z.string().min(1),
  })
  .strict()
export type VitrinePedidoCriacaoResposta = z.infer<
  typeof vitrinePedidoCriacaoRespostaSchema
>

/** Metadados de documento expostos no acompanhamento (allow-list). */
export const vitrinePedidoDocumentoSchema = z
  .object({
    nomeOriginal: z.string().nullable(),
    tipoConteudo: vitrineDocumentoTipoConteudoSchema,
    tamanhoBytes: z.number().int().nonnegative().nullable(),
  })
  .strict()
export type VitrinePedidoDocumento = z.infer<
  typeof vitrinePedidoDocumentoSchema
>

/**
 * Resposta de GET /api/vitrine/pedidos/:token — exclusivamente o pedido do
 * token: dados do negócio, nome do plano, ciclo, status e metadados dos
 * documentos. Nenhum id interno, caminho de armazenamento, texto extraído
 * ou campo de fluxo (pagamentoId/linkAgente/scriptEmbed) faz parte.
 */
export const vitrinePedidoAcompanhamentoSchema = z
  .object({
    nomeNegocio: z.string(),
    nomeContato: z.string(),
    email: z.string(),
    telefone: z.string(),
    informacoesNegocio: z.string().nullable(),
    planoNome: z.string(),
    ciclo: vitrinePedidoCicloSchema,
    status: vitrinePedidoStatusSchema,
    criadoEm: z.string().min(1),
    documentos: z.array(vitrinePedidoDocumentoSchema),
  })
  .strict()
export type VitrinePedidoAcompanhamento = z.infer<
  typeof vitrinePedidoAcompanhamentoSchema
>
