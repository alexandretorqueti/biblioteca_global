/** Falha do runtime que não representa uma resposta/entrega do agente. */
export const AGENT_RUN_FAILED_WITHOUT_REPLY = "The agent run failed before producing a reply."

/**
 * Classificações de falha sem resposta verificável.
 *
 * - `remote_no_reply`: o gateway retornou state=final mas sem conteúdo válido
 *   (resposta vazia, não-string, ou sentinel de falha). O runtime respondeu,
 *   mas a resposta não é uma entrega verificável.
 * - `runtime_unavailable`: o runtime falhou antes de produzir qualquer resposta
 *   (sessão caiu, gateway inacessível, erro de driver). Não houve resposta.
 */
export type NoReplyClassification = "remote_no_reply" | "runtime_unavailable"

/**
 * Resultado da classificação de uma falha sem resposta.
 */
export interface NoReplyFailureDetail {
  classification: NoReplyClassification
  reason: string
  fingerprint: string
}

/**
 * Classifica o motivo de falha quando o conteúdo não é uma entrega válida.
 *
 * - `remote_no_reply`: conteúdo é string vazia, sentinel, ou não-string que
 *   indica resposta do gateway sem entrega (ex.: objeto com state=final mas
 *   content vazio).
 * - `runtime_unavailable`: conteúdo é null/undefined ou sentinel explícito de
 *   falha do runtime (AGENT_RUN_FAILED_WITHOUT_REPLY).
 */
export function classifyNoReplyFailure(content: unknown): NoReplyFailureDetail | null {
  const reason = getAgentReplyFailureReason(content)
  if (!reason) return null

  // Runtime falhou antes de produzir resposta: null, undefined, ou sentinel.
  if (content === null || content === undefined || (typeof content === "string" && content.trim() === AGENT_RUN_FAILED_WITHOUT_REPLY)) {
    return {
      classification: "runtime_unavailable",
      reason,
      fingerprint: computeNoReplyFingerprint("runtime_unavailable", reason),
    }
  }

  // String vazia ou não-string: gateway respondeu mas sem entrega válida.
  if (typeof content !== "string" || !content.trim()) {
    return {
      classification: "remote_no_reply",
      reason,
      fingerprint: computeNoReplyFingerprint("remote_no_reply", reason),
    }
  }

  // Sentinel explícito no conteúdo: runtime respondeu mas com falha.
  return {
    classification: "remote_no_reply",
    reason,
    fingerprint: computeNoReplyFingerprint("remote_no_reply", reason),
  }
}

/**
 * Fingerprint para detecção de falhas repetidas.
 * Combina classificação + motivo normalizado para identificar padrões.
 */
export function computeNoReplyFingerprint(classification: NoReplyClassification, reason: string): string {
  const normalized = reason
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
  return `${classification}:${normalized}`
}

/**
 * Detector de falhas repetidas por fingerprint.
 * Retorna true quando o mesmo fingerprint aparece N vezes consecutivas,
 * indicando falha sistêmica (não transitória).
 */
export function isRepeatedNoReplyFailure(
  fingerprints: readonly string[],
  currentFingerprint: string,
  threshold = 3,
): boolean {
  if (fingerprints.length < threshold - 1) return false
  const recent = fingerprints.slice(-threshold + 1)
  return recent.every((fp) => fp === currentFingerprint)
}

/**
 * Calcula o limite efetivo de tentativas baseado no maxRework configurado.
 * O contador de entrega (deliver_count) é a fonte única de tentativas.
 * O limite efetivo é maxRework + 1 (a primeira entrega não é rework).
 */
export function computeEffectiveRetryLimit(maxRework: number | null | undefined): number {
  const configured = maxRework ?? 3
  return Math.max(1, configured + 1)
}

/**
 * Verifica se o contador de entregas excedeu o limite efetivo.
 */
export function hasExceededRetryLimit(deliverCount: number, maxRework: number | null | undefined): boolean {
  return deliverCount >= computeEffectiveRetryLimit(maxRework)
}

/**
 * Dependências injetáveis para o cálculo de backoff (testabilidade).
 */
export interface BackoffDependencies {
  /** Relógio atual (ms). Padrão: Date.now(). */
  now?: () => number
  /** Fonte de aleatoriedade [0,1). Padrão: Math.random(). */
  random?: () => number
}

/**
 * Calcula o próximo horário de retry com backoff exponencial + jitter.
 *
 * Fórmula: baseDelay * 2^(attempt-1) + jitter
 * - baseDelay: 30s (configurável)
 * - attempt: número da entrega atual (1-indexed)
 * - jitter: aleatório entre 0 e baseDelay * 2^(attempt-1)
 *
 * O jitter evita que múltiplas subtarefas falhem sincronizadamente.
 * O resultado é sempre no futuro (garantia de retry futuro).
 */
export function computeNextRetryAt(
  attempt: number,
  deps: BackoffDependencies = {},
  baseDelayMs = 30_000,
): Date {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const clampedAttempt = Math.max(1, attempt)
  const exponentialDelay = baseDelayMs * Math.pow(2, clampedAttempt - 1)
  const jitter = random() * exponentialDelay
  const delayMs = exponentialDelay + jitter
  return new Date(now() + delayMs)
}

/**
 * Formata o diagnóstico terminal quando o limite de retry é atingido.
 */
export function formatTerminalDiagnostic(
  classification: NoReplyClassification,
  deliverCount: number,
  maxRework: number | null | undefined,
  fingerprint: string,
  lastReason: string,
): string {
  const limit = computeEffectiveRetryLimit(maxRework)
  return [
    `Falha terminal: ${classification}`,
    `Tentativas: ${deliverCount}/${limit}`,
    `Fingerprint: ${fingerprint}`,
    `Último motivo: ${lastReason.slice(0, 200)}`,
  ].join("\n")
}

/**
 * Retorna um motivo canônico quando o runtime não produziu uma entrega válida.
 *
 * O gateway pode reportar `state=final` sem conteúdo ou com o sentinel de
 * falha. Ambos são resultados não verificáveis e não podem atravessar o gate
 * de promoção. Valores não-string também são tratados como ausência, para
 * proteger o motor contra respostas malformadas do driver.
 */
export function getAgentReplyFailureReason(content: unknown): string | null {
  if (typeof content !== "string") return AGENT_RUN_FAILED_WITHOUT_REPLY

  const trimmed = content.trim()
  if (!trimmed || trimmed === AGENT_RUN_FAILED_WITHOUT_REPLY) {
    return AGENT_RUN_FAILED_WITHOUT_REPLY
  }

  return null
}

export function isAgentRunFailureWithoutReply(content: unknown): boolean {
  return getAgentReplyFailureReason(content) !== null
}
