/**
 * Taxonomia de erros do motor — "bloqueio é exceção, não regra"
 * (princípio do Alexandre, 2026-10-29; melhoria #4 do ciclo manual).
 *
 * Três categorias:
 * - `infra`: falha da INFRAESTRUTURA do motor (MySQL fora/timeout/deadlock,
 *   duplicate de outbox, RabbitMQ/conexão, DNS, lock de fila). O trabalho do
 *   agente NÃO falhou — retry transparente com backoff, não consome attempt,
 *   nunca gera bloqueio.
 * - `capacity`: ambiente/capacidade (Console ocupado, HTTP 502/503/504,
 *   provider 429/rate-limit, capacidade de modelo). Espera com backoff,
 *   também não consome attempt nem bloqueia.
 * - `work`: problema real do TRABALHO (código, teste, verificação, gate).
 *   Único caminho que consome attempt e pode terminar em bloqueio + monitor.
 *
 * A classificação inspeciona `code`/`errno` (mysql2, Node), o texto da
 * mensagem e a cadeia de `cause` (até 5 níveis), porque erros de transporte
 * frequentemente chegam embrulhados.
 */

export type MotorErrorKind = 'infra' | 'capacity' | 'work'

export interface MotorErrorClassification {
  kind: MotorErrorKind
  /** Código/errno que fundamentou a classificação (auditoria). */
  evidence?: string
}

/** Códigos do mysql2/MySQL que indicam infraestrutura indisponível ou contenção. */
const INFRA_CODES = new Set([
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_SERVER_SHUTDOWN',
  'ER_CON_COUNT_ERROR', // too many connections
  'ER_HOST_NOT_PRIVILEGED',
  'ER_NOT_FORM_FILE',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * ER_DUP_ENTRY é infra SOMENTE quando a colisão é em tabelas de
 * infraestrutura de mensagens (outbox/processing state) — sinal de
 * redelivery/idempotência, não de trabalho. Em tabelas de negócio o
 * erro deve seguir como `work`.
 */
const INFRA_DUP_TABLES = /motor_outbox|motor_message_processing_state|logical_key/i

/** Padrões de mensagem de infraestrutura (sem código confiável). */
const INFRA_PATTERNS: RegExp[] = [
  /channel closed|operation interrupted|connection lost|socket closed/i, // amqplib
  /illegal state|no reply channel/i,
  /pool is closed|connection pool|too many connections/i,
  /connect econnrefused|getaddrinfo|network unreachable/i,
  /timeout awaiting connection|handshake inactivity/i,
  /lock .* (stale|órfão|orphan)|\.motor-v3-.*\.lock/i, // locks do motor
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/,
]

/** Padrões de capacidade/ambiente — espera, não bloqueio. */
const CAPACITY_PATTERNS: RegExp[] = [
  /\b(429|502|503|504)\b.*(gateway|timeout|unavailable|too many|rate)/i,
  /rate.?limit|too many requests/i,
  /capacity|capacidade/i,
  /service unavailable|bad gateway|gateway time.?out/i,
  /model[_ ]unavailable|provider (unavailable|overloaded)/i,
  /console (ocupado|indisponível|unavailable)|session (busy|occupied)/i,
  /overloaded_error|resource_exhausted/i,
]

const MAX_CAUSE_DEPTH = 5

function inspectOne(error: unknown): MotorErrorClassification | null {
  if (error == null) return null
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown; status?: unknown; statusCode?: unknown }

  const code = typeof candidate.code === 'string' ? candidate.code : null
  const errno = typeof candidate.errno === 'number' || typeof candidate.errno === 'string' ? String(candidate.errno) : null
  const message = error instanceof Error ? error.message : typeof candidate.message === 'string' ? candidate.message : String(error)

  if (code && INFRA_CODES.has(code)) {
    return { kind: 'infra', evidence: `code=${code}` }
  }
  if (code === 'ER_DUP_ENTRY' && INFRA_DUP_TABLES.test(message)) {
    return { kind: 'infra', evidence: 'code=ER_DUP_ENTRY (infra de mensagens)' }
  }
  if (errno && INFRA_CODES.has(errno)) {
    return { kind: 'infra', evidence: `errno=${errno}` }
  }
  for (const pattern of INFRA_PATTERNS) {
    if (pattern.test(message)) return { kind: 'infra', evidence: `message~${pattern.source.slice(0, 60)}` }
  }
  // HTTP de Console/API: 502/503/504 = ambiente/capacidade; 429 = capacidade.
  const httpStatus = Number(candidate.status ?? candidate.statusCode ?? 0)
  if (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return { kind: 'capacity', evidence: `http=${httpStatus}` }
  }
  for (const pattern of CAPACITY_PATTERNS) {
    if (pattern.test(message)) return { kind: 'capacity', evidence: `message~${pattern.source.slice(0, 60)}` }
  }
  return null
}

/**
 * Classifica um erro percorrendo a cadeia de `cause`. Infra/capacidade têm
 * precedência sobre `work`: se QUALQUER elo da cadeia é infra, o erro é
 * infra (o trabalho não teve chance de falhar por mérito próprio).
 */
export function classifyMotorErrorDetail(error: unknown): MotorErrorClassification {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    const result = inspectOne(current)
    if (result) return result
    current = (current as { cause?: unknown }).cause
  }
  return { kind: 'work' }
}

/** Forma curta — categoria do erro. */
export function classifyMotorError(error: unknown): MotorErrorKind {
  return classifyMotorErrorDetail(error).kind
}

/**
 * Erros transitórios (infra/capacity) NÃO consomem attempt e NÃO bloqueiam:
 * o consumidor deve adiar a mensagem com backoff. Só `work` segue o fluxo
 * histórico de retry → falha terminal → bloqueio + monitor.
 */
export function isTransientMotorError(error: unknown): boolean {
  return classifyMotorError(error) !== 'work'
}
