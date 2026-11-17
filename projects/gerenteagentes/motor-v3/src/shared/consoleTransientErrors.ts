/**
 * Detecção de erros transitórios de Console/Gateway — fonte única compartilhada
 * pelo analista (ConsoleAnalystRunner.waitForResult) e pelo worker DEV
 * (primitiva wait_for_completion).
 *
 * Incidente task-p2-1060 (análise): um `sessions.describe` 504 queimou a cadeia
 * inteira de modelos da tentativa. Incidente isas-mt-05/01/07 (bloqueios
 * 3466–3468, 2026-11-17): `Console HTTP 503: Gateway connection closed` durante
 * o polling do DEV esgotou as 3 tentativas do programador em três tarefas
 * simultâneas. Sobrecarga transitória do Console/Gateway não reflete estado
 * terminal da sessão e não deve consumir tentativa.
 */

/** Limite de erros transitórios consecutivos tolerados no polling do Console (~2 min a cada 5s). */
export const TRANSIENT_POLL_ERROR_LIMIT = 24

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Erros de infraestrutura Console/Gateway que não refletem estado terminal da sessão. */
export function isTransientConsoleError(error: Error): boolean {
  return /Console HTTP 50[234]/i.test(error.message)
    || /Gateway request timed out/i.test(error.message)
    || /Gateway connection closed/i.test(error.message)
    || /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error.message)
}
