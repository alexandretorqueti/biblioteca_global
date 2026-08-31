/**
 * Núcleo determinístico do código de verificação (auth única, D5).
 * Código puro, sem Nest — fácil de testar. Mecânica copiada do
 * GerenteAgentes (apps/manager/src/onboarding.ts), adaptada a este schema.
 *
 * Regras:
 * - Código de 6 dígitos crypto-safe (randomInt) — nunca armazenado em claro.
 * - Persistido só o HMAC-SHA256(secret, codigo::email) — D5.
 * - Comparação com timingSafeEqual.
 * - TTL e máximo de tentativas por constante (o service injeta via env).
 */
import {
  createHmac,
  randomInt,
  timingSafeEqual,
} from "crypto"

/** Quantidade de dígitos do código de verificação. */
export const CODIGO_LENGTH = 6

/** TTL padrão do código (10 min) — espelha AUTH_CODE_TTL_MS. */
export const CODIGO_TTL_MS = 10 * 60 * 1000

/** Máximo de tentativas de verificação (estouro invalida o código). */
export const MAX_TENTATIVAS = 5

/** Gera um código de 6 dígitos com zeros à esquerda preservados. */
export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(CODIGO_LENGTH, "0")
}

/**
 * HMAC-SHA256 do código com o e-mail em lowercase — o que é persistido.
 * O código em claro nunca toca o banco (D5).
 */
export function hashCode(
  code: string,
  email: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(code + "::" + email.toLowerCase())
    .digest("hex")
}

/** Comparação em tempo constante com guarda de tamanho. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Regex básica de e-mail (validação de formato apenas). */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
