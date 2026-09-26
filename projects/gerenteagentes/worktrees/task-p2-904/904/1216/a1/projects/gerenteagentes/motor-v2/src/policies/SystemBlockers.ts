/**
 * Bloqueios causados pelo PRÓPRIO Motor/ambiente — não pela entrega.
 *
 * Diferença que importa:
 *  - bloqueio de sistema (aqui): a tarefa não andou porque o Motor não conseguiu
 *    trabalhar (workspace/git/Console indisponível, falha sistêmica repetida,
 *    escada de modelos esgotada). Retomar é seguro e deve ser automático.
 *  - bloqueio de entrega: o dev não entregou, o gate reprovou, a premissa caiu,
 *    o conflito de promoção precisa de decisão. Retomar sozinho seria pular
 *    validação — esses continuam exigindo o fluxo específico/humano.
 *
 * Antes desta política a retomada de um bloqueio de sistema (ex.: "preflight
 * git: blocked" causado por worktree apontando para path inexistente no
 * container do agente) só acontecia via runbook (`recover.js unblock`), e a
 * pendência ficava parada para sempre. Ver incidente de 2026-09-11.
 */

import { isPromotionBlocker } from "./PromotionBlockers.js"

/** Causas em que a responsabilidade é do Motor/ambiente. */
export const SYSTEM_BLOCK_REASONS = ["blocked_environment", "systemic_failure", "model_chain_exhausted"] as const

export type SystemBlockReason = typeof SYSTEM_BLOCK_REASONS[number]

/** Recorte SQL equivalente, para uso nas varreduras do coordenador. */
export const SYSTEM_BLOCK_REASON_SQL_LIST = `(${SYSTEM_BLOCK_REASONS.map((reason) => `'${reason}'`).join(", ")})`

/**
 * Retomada automática só é segura quando a causa é do Motor/ambiente e o
 * bloqueio NÃO pertence a um fluxo de promoção (conflito/repo sujo/lock), que
 * tem orquestração própria e precisa manter o gate de promoção de pé.
 */
export function isSystemBlocker(
  blockReason: string | null | undefined,
  blockCommand = "",
  blockExcerpt = "",
): boolean {
  if (!(SYSTEM_BLOCK_REASONS as readonly string[]).includes(String(blockReason ?? ""))) return false
  if (isPromotionBlocker(blockCommand, blockExcerpt)) return false
  return true
}

/** Quantas retomadas automáticas são permitidas por subtarefa + causa em 24h. */
export const SYSTEM_BLOCK_MAX_AUTO_RETRIES = 3

/** Carência antes de retomar: dá tempo de o fluxo dono (ou humano) agir. */
export const SYSTEM_BLOCK_COOLDOWN_SECONDS = 90
