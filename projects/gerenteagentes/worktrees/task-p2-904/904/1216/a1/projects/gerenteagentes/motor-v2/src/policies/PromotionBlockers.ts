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

/**
 * Outras gerações do MESMO bloqueio de checkout sujo, gravadas antes (ou fora)
 * do prefixo estruturado. A terceira variante apareceu como
 * `motor-v2:repositório principal não está limpo: <arquivo>` e a integração
 * falhava como `motor-v2:integração falhou: repositório principal não está
 * limpo para integração:`. As três dizem a mesma coisa: o repo base tinha
 * alteração pendente e a promoção não pôde rodar.
 */
export const PROMOTION_DIRTY_LEGACY_COMMANDS = [
  "motor-v2:repositório principal não está limpo:",
  "motor-v2:integração falhou: repositório principal não está limpo",
]

/** Qualquer falha da promoção tarefa→base (lock de integração, repo sujo, etc.). */
export const PROMOTION_FAILURE_LEGACY_COMMAND_PREFIX = "motor-v2:falha na promoção da branch da tarefa:"

/** Bloqueios anteriores ao formato estruturado: identificados pelo texto. */
export const PROMOTION_CONFLICT_LEGACY_EXCERPT = /Conflito no merge da branch da tarefa para a base/i
export const PROMOTION_DIRTY_LEGACY_EXCERPT = /repositório principal não está limpo/i
export const PROMOTION_FAILURE_LEGACY_EXCERPT = /Falha na promoção da branch da tarefa:/i

export function isPromotionConflictBlocker(blockCommand: string, blockExcerpt = ""): boolean {
  return blockCommand.startsWith(PROMOTION_CONFLICT_COMMAND_PREFIX) || PROMOTION_CONFLICT_LEGACY_EXCERPT.test(blockExcerpt)
}

export function isPromotionDirtyBlocker(blockCommand: string, blockExcerpt = ""): boolean {
  const normalized = blockCommand.toLowerCase()
  return blockCommand.startsWith(PROMOTION_DIRTY_COMMAND_PREFIX) ||
    PROMOTION_DIRTY_LEGACY_COMMANDS.some((prefix) => normalized.startsWith(prefix.toLowerCase())) ||
    PROMOTION_DIRTY_LEGACY_EXCERPT.test(blockExcerpt)
}

/**
 * Falha genérica de promoção (ex.: timeout adquirindo o lock de integração).
 * Não aciona os fluxos de conflito/sujo — serve para reconhecimento unificado
 * e para a higiene de bloqueio obsoleto em tarefa já integrada.
 */
export function isPromotionFailureBlocker(blockCommand: string, blockExcerpt = ""): boolean {
  return blockCommand.toLowerCase().startsWith(PROMOTION_FAILURE_LEGACY_COMMAND_PREFIX) ||
    PROMOTION_FAILURE_LEGACY_EXCERPT.test(blockExcerpt)
}

export function isPromotionBlocker(blockCommand: string, blockExcerpt = ""): boolean {
  return isPromotionConflictBlocker(blockCommand, blockExcerpt) ||
    isPromotionDirtyBlocker(blockCommand, blockExcerpt) ||
    isPromotionFailureBlocker(blockCommand, blockExcerpt)
}

/** Recorte SQL equivalente aos predicados acima. O alias é parametrizável porque
 * várias consultas precisam do mesmo recorte em sub-selects (`b2`, `blk`). */
export function promotionConflictSqlFilter(alias = "b"): string {
  return `(${alias}.block_command LIKE '${PROMOTION_CONFLICT_COMMAND_PREFIX}%' OR ${alias}.block_excerpt LIKE 'Conflito no merge da branch da tarefa para a base%')`
}

export function promotionDirtySqlFilter(alias = "b"): string {
  const legacy = PROMOTION_DIRTY_LEGACY_COMMANDS.map((prefix) => `${alias}.block_command LIKE '${prefix}%'`).join(" OR ")
  return `(${alias}.block_command LIKE '${PROMOTION_DIRTY_COMMAND_PREFIX}%' OR ${legacy} OR ${alias}.block_excerpt LIKE '%repositório principal não está limpo%')`
}

export function promotionFailureSqlFilter(alias = "b"): string {
  return `(${alias}.block_command LIKE '${PROMOTION_FAILURE_LEGACY_COMMAND_PREFIX}%' OR ${alias}.block_excerpt LIKE 'Falha na promoção da branch da tarefa:%')`
}

export function promotionBlockerSqlFilter(alias = "b"): string {
  return `(${promotionConflictSqlFilter(alias)} OR ${promotionDirtySqlFilter(alias)} OR ${promotionFailureSqlFilter(alias)})`
}

/** Recortes padrão (alias `b`), mantidos para os consumidores existentes. */
export const PROMOTION_CONFLICT_SQL_FILTER = promotionConflictSqlFilter()
export const PROMOTION_DIRTY_SQL_FILTER = promotionDirtySqlFilter()
export const PROMOTION_FAILURE_SQL_FILTER = promotionFailureSqlFilter()
export const PROMOTION_BLOCKER_SQL_FILTER = promotionBlockerSqlFilter()
