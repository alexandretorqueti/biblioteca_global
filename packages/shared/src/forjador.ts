/**
 * Contratos do Forjador por API (isas-mt-04): `POST forjar-persona`.
 *
 * A chamada dispara uma sessão do Forjador (agente definicaopersonalidadeagentes)
 * com o material recebido, aguarda a conclusão (padrão waitForSessionIdle do
 * project-provisioner legado) e retorna a persona gerada — SOUL/IDENTITY/AGENTS —
 * vinculada ao tenant. O vínculo é PROVISÓRIO por `tenantSlug`/`tenantId`
 * (convenção de `assinaturas`: sem FK enquanto a tabela tenants de isas-mt-01
 * não existir no core). `correlationId` é a chave de idempotência/retomada em
 * caso de timeout.
 *
 * Esta tarefa entrega a PERSONA (textos) por chamada de API — não cria registro
 * de agente OpenClaw (gate de config do gateway é etapa separada).
 */
import { z } from "zod"

/** Limite mínimo de caracteres da descrição do negócio. */
export const FORJAR_PERSONA_DESCRICAO_MIN = 10

/** Limite máximo de caracteres da descrição do negócio. */
export const FORJAR_PERSONA_DESCRICAO_MAX = 5000

/** Máximo de arquivos enviados como material da persona. */
export const FORJAR_PERSONA_ARQUIVOS_MAX = 10

/** Máximo de bytes (UTF-8) do conteúdo de cada arquivo do material. */
export const FORJAR_PERSONA_ARQUIVO_MAX_BYTES = 256 * 1024

/** Máximo de caracteres do nome de arquivo do material. */
export const FORJAR_PERSONA_ARQUIVO_NOME_MAX = 200

/** Convenção de slug de tenant: minúsculas, dígitos e hífen, 1–64 chars
 *  (espelha `assinaturas.tenant_slug` varchar(64)). */
export const TENANT_SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Status do ciclo de vida de uma persona forjada. */
export const forjarPersonaStatusSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "timeout",
])

export type ForjarPersonaStatus = z.infer<typeof forjarPersonaStatusSchema>

/** Arquivo de material enviado ao Forjador (conteúdo em texto; limite em bytes UTF-8). */
export const forjarArquivoSchema = z
  .object({
    nome: z.string().trim().min(1).max(FORJAR_PERSONA_ARQUIVO_NOME_MAX),
    conteudo: z
      .string()
      .min(1)
      .max(FORJAR_PERSONA_ARQUIVO_MAX_BYTES, {
        message: "conteúdo excede o limite de bytes",
      })
      .refine((valor) => utf8ByteLength(valor) <= FORJAR_PERSONA_ARQUIVO_MAX_BYTES, {
        message: "conteúdo excede o limite de bytes",
      }),
  })
  .strict()

export type ForjarArquivo = z.infer<typeof forjarArquivoSchema>

/** Requisito de `POST forjar-persona`. */
export const forjarPersonaRequestSchema = z
  .object({
    /** Descrição do negócio — insumo principal da persona. */
    descricaoNegocio: z
      .string()
      .trim()
      .min(FORJAR_PERSONA_DESCRICAO_MIN)
      .max(FORJAR_PERSONA_DESCRICAO_MAX),
    /** Vínculo provisório do tenant (convenção de assinaturas: slug, sem FK). */
    tenantSlug: z
      .string()
      .regex(TENANT_SLUG_REGEX)
      .optional(),
    /** Reservado para a FK de tenants, a ser adicionada no follow-up isas-mt-01. */
    tenantId: z.number().int().positive().optional(),
    /** Chave de idempotência/retomada em caso de timeout. */
    correlationId: z.string().trim().min(1).max(100).optional(),
    /** Material complementar (máx. 10 arquivos de até 256 KiB). */
    arquivos: z.array(forjarArquivoSchema).max(FORJAR_PERSONA_ARQUIVOS_MAX).optional(),
  })
  .strict()

export type ForjarPersonaRequest = z.infer<typeof forjarPersonaRequestSchema>

/** Resposta de `POST forjar-persona` — persona gerada vinculada ao tenant. */
export const forjarPersonaResponseSchema = z
  .object({
    personaId: z.number().int().positive(),
    versao: z.number().int().positive(),
    tenantSlug: z.string().regex(TENANT_SLUG_REGEX).optional(),
    soul: z.string().min(1),
    identity: z.string().min(1),
    agents: z.string().min(1),
    status: forjarPersonaStatusSchema,
  })
  .strict()

export type ForjarPersonaResponse = z.infer<typeof forjarPersonaResponseSchema>

/** SHA-256 (hex, minúsculas) — formato de `personas_forjadas.material_hash`. */
export const MATERIAL_HASH_REGEX = /^[0-9a-f]{64}$/

/**
 * Comprimento em bytes UTF-8 — o limite de material é medido em bytes, não em
 * caracteres UTF-16. Implementação pura (sem TextEncoder/Buffer) para manter
 * `packages/shared` agnóstico de ambiente (lib ES2022, roda em browser e Node).
 */
function utf8ByteLength(valor: string): number {
  let bytes = 0
  for (const caractere of valor) {
    const codePoint = caractere.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}
