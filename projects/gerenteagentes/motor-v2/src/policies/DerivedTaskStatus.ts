import type { TaskStatus } from "../shared/types/index.js"

/**
 * Fatos mínimos para calcular o estado operacional de uma tarefa.
 *
 * O resultado não depende do valor materializado em `tarefas.status`. Os
 * status terminais administrativos permanecem preservados até que a migração
 * desses comandos seja concluída.
 */
export interface DerivedTaskStatusFacts {
  persistedStatus?: string | null
  hasPendingClarification: boolean
  hasActiveBlocker: boolean
  analysisInProgress: boolean
  hasPersistedPlan: boolean
  subtaskStatuses: readonly string[]
  deploySucceeded: boolean
  integrationConfirmed: boolean
}

const APPROVED_SUBTASK_STATUSES = new Set(["verified", "superseded"])
const ACTIVE_SUBTASK_STATUSES = new Set(["running", "delivered", "verifying"])
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
  const persisted = facts.persistedStatus as TaskStatus | undefined
  if (persisted && ADMINISTRATIVE_TERMINAL_STATUSES.has(persisted)) return persisted

  if (facts.hasPendingClarification) return "awaiting_clarification"
  if (facts.hasActiveBlocker) return "blocked"
  if (facts.analysisInProgress && !facts.hasPersistedPlan) return "analyzing"
  if (facts.subtaskStatuses.some((status) => ACTIVE_SUBTASK_STATUSES.has(status))) return "running"
  if (facts.deploySucceeded) return "deployed"

  const hasSubtasks = facts.subtaskStatuses.length > 0
  const allSubtasksApproved = hasSubtasks && facts.subtaskStatuses.every(
    (status) => APPROVED_SUBTASK_STATUSES.has(status),
  )
  if (allSubtasksApproved && facts.integrationConfirmed) return "completed"
  if (hasSubtasks) return "ready"

  return "planned"
}

/** `paused_at` é uma condição de fila, não outro estado de negócio. */
export function isTaskExecutionEligible(
  status: TaskStatus,
  pausedAt: string | null | undefined,
): boolean {
  return status === "ready" && !pausedAt
}
