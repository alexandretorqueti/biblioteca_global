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
  awaitingInteraction: boolean
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
const FAILED_SUBTASK_STATUSES = new Set(["failed"])
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

  const hasSubtasks = facts.subtaskStatuses.length > 0
  const allSubtasksApproved = hasSubtasks && facts.subtaskStatuses.every(
    (status) => APPROVED_SUBTASK_STATUSES.has(status),
  )

  // Pausa continua prevalecendo sobre estados intermediários, mas não pode
  // esconder uma conclusão ou deploy já confirmado.
  if (facts.pausedAt && !facts.resourceWaitKey) {
    if (facts.deploySucceeded) return "deployed"
    if (allSubtasksApproved && (facts.integrationConfirmed || facts.deployFailed)) return "completed"
    if (!hasSubtasks) return "draft"
    return "paused"
  }

  if (facts.hasPendingClarification) return "awaiting_clarification"
  if (facts.awaitingInteraction) return "awaiting_interaction"
  // Falha definitiva exige intervenção humana. Sem esta regra a tarefa voltava
  // a `ready` e saía da estação Atenção (caso real: tarefa 855/subtarefa 1170).
  if (facts.subtaskStatuses.some((status) => FAILED_SUBTASK_STATUSES.has(status))) return "failed"
  if (facts.subtaskStatuses.some((status) => BLOCKED_SUBTASK_STATUSES.has(status))) return "blocked"
  if (facts.analysisInProgress && !facts.hasPersistedPlan) return "analyzing"
  if (facts.subtaskStatuses.some((status) => ACTIVE_SUBTASK_STATUSES.has(status))) return "running"
  if (facts.deploySucceeded) return "deployed"

  if (allSubtasksApproved && facts.integrationConfirmed) return "completed"

  // Bug 801: Se todas as subtarefas estão aprovadas mas o deploy falhou,
  // o desenvolvimento foi concluído — retornar "completed" (deploy é etapa
  // operacional separada, não deve bloquear o status de conclusão).
  if (allSubtasksApproved && facts.deployFailed) return "completed"

  // Uma pausa antiga não mascara estados finais já confirmados. Para tarefas
  // não finais, a pausa continua impedindo a seleção pela fila e é exibida.
  if (facts.pausedAt && !facts.resourceWaitKey) return "paused"

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
