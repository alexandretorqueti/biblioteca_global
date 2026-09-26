/**
 * Cooldown de modelos (2026-09-13, Alexandre).
 *
 * Quando o provedor de um modelo está indisponível (sem token/autenticação,
 * cota esgotada, modelo removido) ou a sessão não entrega, o Motor para de
 * chamar esse modelo por um período, em vez de reiniciar a cadeia do zero a
 * cada subtarefa e insistir no mesmo modelo quebrado.
 *
 * Escopo GLOBAL (`provider/model`): token e cota pertencem à conta, não ao
 * projeto. Reincidência cresce em 50% por padrão, com teto configurável.
 *
 * Este módulo é puro (exceto a leitura de configuração): a persistência fica em
 * `database/ModelCooldownStore.ts`.
 */

import { getConfigNumber } from "../config/MotorConfigReader.js"

export type ModelCooldownClass = "auth" | "quota" | "not_found" | "session"

/** Ordem importa: assinaturas mais específicas primeiro. */
const AUTH_PATTERN = /missing[_-]?provider[_-]?auth|provider[ _-]?auth|no api key|missing api key|invalid api key|authentication error|unauthorized|\b(401|403)\b/i
const NOT_FOUND_PATTERN = /model[_ -]?not[_ -]?found|model not allowed|model unavailable|\b404\b/i
const QUOTA_PATTERN = /quota|rate[_ -]?limit|too many requests|exhausted|insufficient|billing|credits|token-plan|\b429\b/i

/** Classe do motivo. Sem assinatura reconhecida, trata como falha de sessão. */
export function classifyCooldown(text: string): ModelCooldownClass {
  const value = text ?? ""
  if (AUTH_PATTERN.test(value)) return "auth"
  if (NOT_FOUND_PATTERN.test(value)) return "not_found"
  if (QUOTA_PATTERN.test(value)) return "quota"
  return "session"
}

const CONFIG_KEY: Record<ModelCooldownClass, string> = {
  auth: "motor.model_cooldown_auth_ms",
  quota: "motor.model_cooldown_quota_ms",
  not_found: "motor.model_cooldown_not_found_ms",
  session: "motor.model_cooldown_session_ms",
}

/** Usados quando o catálogo/configuração não está disponível. */
const DEFAULT_MS: Record<ModelCooldownClass, number> = {
  auth: 3_600_000,        // 1 h  — sem token/chave não se resolve sozinho
  quota: 600_000,         // 10 min — cota/rate limit costuma recuperar
  not_found: 21_600_000,  // 6 h — modelo removido/renomeado
  session: 900_000,       // 15 min — sessão que não entrega (2 falhas iguais)
}

const FALLBACK_GROWTH_FACTOR = 1.5
const FALLBACK_MAX_MS = 43_200_000 // 12 h

export const MODEL_COOLDOWN_DEFAULT_MS = DEFAULT_MS

export function cooldownBaseMs(classe: ModelCooldownClass): number {
  const configured = getConfigNumber(CONFIG_KEY[classe])
  return configured > 0 ? configured : DEFAULT_MS[classe]
}

export function cooldownGrowthFactor(): number {
  const factor = getConfigNumber("motor.model_cooldown_growth_factor")
  return factor >= 1 ? factor : FALLBACK_GROWTH_FACTOR
}

export function cooldownMaxMs(): number {
  const max = getConfigNumber("motor.model_cooldown_max_ms")
  return max > 0 ? max : FALLBACK_MAX_MS
}

/**
 * Duração do próximo cooldown.
 * `strikes` conta as reincidências acumuladas (1 = primeira falha):
 * `base * fator^(strikes-1)`, limitado ao teto (nunca menor que a base).
 */
export function cooldownDurationMs(classe: ModelCooldownClass, strikes: number): number {
  const base = cooldownBaseMs(classe)
  const factor = cooldownGrowthFactor()
  const max = Math.max(cooldownMaxMs(), base)
  const normalized = Math.max(1, Math.floor(strikes))
  const duration = base * Math.pow(factor, normalized - 1)
  if (!Number.isFinite(duration)) return max
  return Math.min(Math.round(duration), max)
}

export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

export function splitModelKey(fullName: string): { provider: string; model: string } {
  const index = fullName.indexOf("/")
  if (index === -1) return { provider: "unknown", model: fullName }
  return { provider: fullName.slice(0, index), model: fullName.slice(index + 1) }
}

export type ActiveCooldown = {
  model: string
  classe: ModelCooldownClass
  until: Date
  strikes: number
}

/**
 * Assinatura textual usada para registrar o cooldown. Junta código e mensagem
 * (o código pode vir vazio quando a falha chega só como texto da sessão).
 */
export function cooldownReason(code: string | undefined, message: string | undefined): string {
  return [code ?? "", message ?? ""].filter((part) => part.length > 0).join(" ").slice(0, 500)
}

/**
 * Erro dedicado: a cadeia inteira está em cooldown. Não é bloqueio de negócio —
 * o Motor apenas adia a execução até o primeiro modelo liberar.
 */
export class ModelCooldownExhaustedError extends Error {
  readonly phase: string
  readonly projectSlug: string | null
  readonly until: Date | null
  readonly models: readonly string[]

  constructor(phase: string, projectSlug: string | null, until: Date | null, models: readonly string[]) {
    super(
      `Todos os modelos da cadeia ${phase}${projectSlug ? ` do projeto ${projectSlug}` : ""} estão em cooldown` +
      (until ? ` até ${until.toISOString()}` : "") +
      (models.length > 0 ? ` (${models.join(", ")})` : "") +
      ". A execução será retomada quando o primeiro modelo liberar.",
    )
    this.name = "ModelCooldownExhaustedError"
    this.phase = phase
    this.projectSlug = projectSlug
    this.until = until
    this.models = models
  }
}
