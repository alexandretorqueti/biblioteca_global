/**
 * Fonte única de reconhecimento dos bloqueios de promoção tarefa -> base.
 *
 * Existem três gerações de registro persistido em `bloqueios`:
 *  - estruturado (atual): `motor-v2:promotion-conflict:<base>:<branch>:<fp>`
 *                         `motor-v2:promotion-repo-dirty:<base>:<branch>:<n>`
 *  - legado textual no `block_excerpt` (conflito de merge e checkout sujo).
 *
 * Antes cada componente duplicava o próprio `LIKE`, e os filtros divergiam
 * (um reconhecia só o estruturado, outro só o excerpt). Isso permitia que o
 * mesmo bloqueio fosse tratado — ou ignorado — de formas diferentes. As regras
 * agora vivem aqui e são reutilizadas por detectores, repositórios e pelo
 * orquestrador do gate de promoção.
 */

export const PROMOTION_CONFLICT_COMMAND_PREFIX = "motor-v2:promotion-conflict:"
export const PROMOTION_DIRTY_COMMAND_PREFIX = "motor-v2:promotion-repo-dirty:"

/** Bloqueios anteriores ao formato estruturado: identificados pelo texto. */
export const PROMOTION_CONFLICT_LEGACY_EXCERPT = /Conflito no merge da branch da tarefa para a base/i
export const PROMOTION_DIRTY_LEGACY_EXCERPT = /Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção:/i

export function isPromotionConflictBlocker(blockCommand: string, blockExcerpt = ""): boolean {
  return blockCommand.startsWith(PROMOTION_CONFLICT_COMMAND_PREFIX) || PROMOTION_CONFLICT_LEGACY_EXCERPT.test(blockExcerpt)
}

export function isPromotionDirtyBlocker(blockCommand: string, blockExcerpt = ""): boolean {
  return blockCommand.startsWith(PROMOTION_DIRTY_COMMAND_PREFIX) || PROMOTION_DIRTY_LEGACY_EXCERPT.test(blockExcerpt)
}

export function isPromotionBlocker(blockCommand: string, blockExcerpt = ""): boolean {
  return isPromotionConflictBlocker(blockCommand, blockExcerpt) || isPromotionDirtyBlocker(blockCommand, blockExcerpt)
}

/** Recorte SQL equivalente aos predicados acima, para uso com o alias `b`. */
export const PROMOTION_CONFLICT_SQL_FILTER =
  `(b.block_command LIKE '${PROMOTION_CONFLICT_COMMAND_PREFIX}%' OR b.block_excerpt LIKE 'Conflito no merge da branch da tarefa para a base%')`

export const PROMOTION_DIRTY_SQL_FILTER =
  `(b.block_command LIKE '${PROMOTION_DIRTY_COMMAND_PREFIX}%' OR b.block_excerpt LIKE 'Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção:%')`

export const PROMOTION_BLOCKER_SQL_FILTER = `(${PROMOTION_CONFLICT_SQL_FILTER} OR ${PROMOTION_DIRTY_SQL_FILTER})`
