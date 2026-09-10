import type { PromotionConflictCandidate } from "./promotion-conflict.types.js"

const LEGACY_PROMOTION_MESSAGE = /Conflito no merge da branch da tarefa para a base/i
const BRANCH_PATTERN = /Branch preservada:\s*([^\s,]+)/i
const BASE_PATTERN = /para a base \(([^)]+)\)/i
const FILES_PATTERN = /Arquivos em conflito:\s*(.+?)\.\s*Branch preservada:/i

function structuredBranches(command: string): { baseBranch?: string; taskBranch?: string } {
  const match = command.match(/^motor-v2:promotion-conflict:([^:]+):([^:]+):[a-f0-9]+$/i)
  if (!match) return {}
  try { return { baseBranch: decodeURIComponent(match[1]!), taskBranch: decodeURIComponent(match[2]!) } }
  catch { return {} }
}

/**
 * Reconhece exclusivamente conflitos da promoção tarefa -> base.
 * O fallback textual existe para bloqueios anteriores ao tipo estruturado;
 * erros genéricos de Git e conflitos entre subtarefas não entram neste fluxo.
 */
export function identifyPromotionConflict(row: Record<string, unknown>): PromotionConflictCandidate | null {
  const excerpt = String(row.block_excerpt ?? "")
  const command = String(row.block_command ?? "")
  const structured = command.startsWith("motor-v2:promotion-conflict:")
  if (!structured && !LEGACY_PROMOTION_MESSAGE.test(excerpt)) return null
  if (row.subtarefa_id != null) return null

  const encoded = structuredBranches(command)
  const taskBranch = String(row.task_branch ?? encoded.taskBranch ?? excerpt.match(BRANCH_PATTERN)?.[1] ?? "")
  const baseBranch = String(row.base_branch ?? encoded.baseBranch ?? excerpt.match(BASE_PATTERN)?.[1] ?? "")
  const repoPath = String(row.repo_path ?? "")
  const agentId = String(row.agent_id ?? "")
  const taskId = String(row.external_id ?? row.tarefa_id ?? "")
  if (!taskBranch || !baseBranch || !repoPath || !agentId || !taskId) return null

  const reported = excerpt.match(FILES_PATTERN)?.[1]
    ?.split(",")
    .map((file) => file.trim())
    .filter(Boolean)

  return {
    taskId,
    taskDatabaseId: Number(row.tarefa_id) || undefined,
    blockId: Number(row.block_id ?? row.id) || undefined,
    agentId,
    repoPath,
    baseBranch,
    taskBranch,
    reportedFiles: reported,
  }
}
