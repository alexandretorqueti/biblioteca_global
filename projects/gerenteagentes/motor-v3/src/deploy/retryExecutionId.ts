/**
 * Geração de execution_id de retry com tamanho limitado.
 *
 * O reenfileiramento por deploy_lock/deploy_in_progress ou
 * analysis_capacity_waiting soltava um novo sufixo `-deploy-retry-<timestamp>`
 * (ou `-retry-<timestamp>`) sobre o execution_id anterior a cada ciclo. Em
 * cadeias longas de retries o valor ultrapassava o limite da coluna
 * `motor_outbox.execution_id` — varchar(200), definido em
 * `migrations/0051_motor_v3_runtime.sql` e
 * `motor-v3/drizzle/migrations/0003_motor_outbox.sql` — causando
 * ER_DATA_TOO_LONG e travando o retry. Este utilitário remove o(s) sufixo(s)
 * de retry anterior(es), trunca a base quando necessário e anexa um único
 * marcador variável, garantindo resultado ≤ 200 caracteres.
 */

/** Limite da coluna `motor_outbox.execution_id` (varchar(200)). */
export const EXECUTION_ID_MAX_LENGTH = 200

/** Marcador de retry suportado nos caminhos de reenfileiramento. */
export type RetryExecutionMarker = 'retry' | 'deploy-retry'

/** Sufixo de retry no fim do execution_id: `-retry-<timestamp>` ou `-deploy-retry-<timestamp>`. */
const RETRY_SUFFIX_PATTERN = /(?:-deploy)?-retry-\d+$/

/**
 * Remove todos os sufixos de retry acumulados no fim do execution_id de
 * origem (inclusive cadeias legadas com múltiplos marcadores encadeados),
 * preservando o texto base.
 */
export function stripRetrySuffixes(executionId: string): string {
  let current = executionId
  while (RETRY_SUFFIX_PATTERN.test(current)) {
    current = current.replace(RETRY_SUFFIX_PATTERN, '')
  }
  return current
}

/**
 * Gera o execution_id de um retry a partir do execution_id da mensagem de
 * origem: remove o sufixo de retry anterior, trunca a base quando preciso e
 * anexa `-<marker>-<timestamp>`. O resultado é sempre estável em formato e
 * limitado a `EXECUTION_ID_MAX_LENGTH` caracteres, mantendo o componente
 * variável (timestamp) para rastreabilidade.
 */
export function buildRetryExecutionId(
  sourceExecutionId: string,
  marker: RetryExecutionMarker,
  timestamp: number = Date.now(),
): string {
  const base = stripRetrySuffixes(sourceExecutionId)
  const suffix = `-${marker}-${timestamp}`
  const maxBaseLength = EXECUTION_ID_MAX_LENGTH - suffix.length
  const truncatedBase = base.length > maxBaseLength ? base.slice(0, maxBaseLength) : base
  return `${truncatedBase}${suffix}`
}
