import type { TaskStatus } from "../shared/types/index.js"

/**
 * Fatos mínimos para calcular o estado operacional de uma tarefa.
 *
 * O resultado não depende do valor materializado em `tarefas.status`. Os
 * status terminais administrativos permanecem preservados até que a migração
 * desses comandos seja concluída.
 */
export interface DerivedTaskStatusFacts {
  terminalStatus?: string | null
  /** Compatibilidade somente para linhas anteriores à migration 0029. */
  persistedStatus?: string | null
  hasPendingClarification: boolean
  hasActiveBlocker: boolean
  analysisInProgress: boolean
  hasPersistedPlan: boolean
  subtaskStatuses: readonly string[]
  deploySucceeded: boolean
  deployFailed: boolean
  integrationConfirmed: boolean
  pausedAt?: string | null
  resourceWaitKey?: string | null
}

const APPROVED_SUBTASK_STATUSES = new Set(["verified", "superseded"])
const ACTIVE_SUBTASK_STATUSES = new Set(["running", "delivered", "verifying"])
const BLOCKED_SUBTASK_STATUSES = new Set(["blocked"])
const ADMINISTRATIVE_TERMINAL_STATUSES = new Set<TaskStatus>([
  "cancelled",
  "failed",
  "motor_fix",
])

/**
 * Calcula o status visível da tarefa a partir dos fatos persistidos.
 * A ordem reproduz a prioridade definida em STATUS-DERIVADO-DE-TAREFAS.md.
 */
export function deriveTaskStatus(facts: DerivedTaskStatusFacts): TaskStatus {
  const terminal = (facts.terminalStatus ?? facts.persistedStatus) as TaskStatus | undefined
  if (terminal && ADMINISTRATIVE_TERMINAL_STATUSES.has(terminal)) return terminal

  // Bug 802/803: Pausa tem prioridade sobre clarificação pendente.
  // Se o usuário pausou a tarefa, o status deve ser "paused" independente
  // de haver clarificação pendente ou bloqueio de deploy.
  if (facts.pausedAt && !facts.resourceWaitKey) return "paused"

  if (facts.hasPendingClarification) return "awaiting_clarification"
  if (facts.subtaskStatuses.some((status) => BLOCKED_SUBTASK_STATUSES.has(status))) return "blocked"
  if (facts.analysisInProgress && !facts.hasPersistedPlan) return "analyzing"
  if (facts.subtaskStatuses.some((status) => ACTIVE_SUBTASK_STATUSES.has(status))) return "running"
  if (facts.deploySucceeded) return "deployed"

  const hasSubtasks = facts.subtaskStatuses.length > 0
  const allSubtasksApproved = hasSubtasks && facts.subtaskStatuses.every(
    (status) => APPROVED_SUBTASK_STATUSES.has(status),
  )
  if (allSubtasksApproved && facts.integrationConfirmed) return "completed"

  // Bug 801: Se todas as subtarefas estão aprovadas mas o deploy falhou,
  // o desenvolvimento foi concluído — retornar "completed" (deploy é etapa
  // operacional separada, não deve bloquear o status de conclusão).
  if (allSubtasksApproved && facts.deployFailed) return "completed"

  // Bloqueio de deploy só se aplica quando o desenvolvimento ainda não concluiu
  if (facts.hasActiveBlocker) return "blocked"

  if (hasSubtasks) {
    return "ready"
  }

  return "planned"
}

/** `paused_at` é uma condição de fila, não outro estado de negócio. */
export function isTaskExecutionEligible(
  status: TaskStatus,
  pausedAt: string | null | undefined,
): boolean {
  return status === "ready" && !pausedAt
}
