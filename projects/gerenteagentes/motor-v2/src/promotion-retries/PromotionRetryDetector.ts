import type { PromotionRetryCandidate } from "./promotion-retry.types.js"

const DIRTY_MESSAGE = /Falha na promoção da branch da tarefa: repositório principal não está limpo para promoção:/i
const PRESERVED_BRANCH = /Branch preservada:\s*([^\s,]+)/i

/** Reconhece exclusivamente o bloqueio transitório de checkout sujo na promoção. */
export function identifyDirtyPromotionRetry(row: Record<string, unknown>): PromotionRetryCandidate | null {
  if (row.subtarefa_id != null) return null
  const command = String(row.block_command ?? "")
  const excerpt = String(row.block_excerpt ?? "")
  const structured = command.match(/^motor-v2:promotion-repo-dirty:([^:]+):([^:]+):(\d+)$/)
  if (!structured && !DIRTY_MESSAGE.test(excerpt)) return null
  const taskBranch = structured ? decodeURIComponent(structured[2]!) : excerpt.match(PRESERVED_BRANCH)?.[1]
  const baseBranch = structured ? decodeURIComponent(structured[1]!) : String(row.base_branch ?? "")
  const taskId = String(row.external_id ?? row.tarefa_id ?? "")
  const repoPath = String(row.repo_path ?? "")
  const blockId = Number(row.block_id ?? row.id)
  if (!taskId || !repoPath || !baseBranch || !taskBranch || !Number.isFinite(blockId)) return null
  return {
    taskId, taskDatabaseId: Number(row.tarefa_id) || undefined, blockId,
    projectSlug: row.project_slug == null ? null : String(row.project_slug),
    repoPath, baseBranch, taskBranch,
    attempt: structured ? Number(structured[3]) : 0,
  }
}
