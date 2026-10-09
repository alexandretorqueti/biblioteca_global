/**
 * Fonte única de verdade para status de tarefa e subtarefa no GerenteAgentes.
 *
 * Centraliza valores, labels amigáveis, cores e conjuntos auxiliares para que
 * adicionar/remover status exija mudança em um só lugar.
 *
 * Consumidores:
 * - TaskMonitorScreen (combo de filtro, Chip de cor, formulário de edição)
 * - gerenteagentes.service (validação de transições)
 * - schema.ts (annotations / helperText)
 * - config.ts (options de select, valuesLast)
 */

// ============================================================================
// TASK STATUS
// ============================================================================

/** Todos os status possíveis de uma tarefa (fonte canônica). */
export const TASK_STATUSES = [
  "draft", "planned", "analyzing", "awaiting_clarification", "awaiting_interaction",
  "ready", "running", "paused", "completed", "closed", "deployed", "blocked",
  "motor_fix", "failed", "cancelled",
] as const
export type TaskStatusValue = (typeof TASK_STATUSES)[number]

/** Status legados que podem existir em registros antigos (v1). */
export const TASK_STATUSES_LEGACY = ["finalizada", "deployada", "aborted"] as const
export type TaskStatusLegacy = (typeof TASK_STATUSES_LEGACY)[number]
/** União de todos os status de tarefa (atuais + legados). */
export const ALL_TASK_STATUSES = [...TASK_STATUSES, ...TASK_STATUSES_LEGACY] as const
export type AnyTaskStatus = TaskStatusValue | TaskStatusLegacy

/** Labels amigáveis para cada status de tarefa. */
export const TASK_STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho", planned: "Planejada", analyzing: "Em análise",
  awaiting_clarification: "Aguardando esclarecimento", awaiting_interaction: "Aguardando você",
  ready: "Pronta", running: "Em execução", paused: "Pausada", completed: "Concluída",
  closed: "Encerrada", deployed: "Deployada", blocked: "Bloqueada", motor_fix: "Correção do motor",
  failed: "Falhou", cancelled: "Cancelada", finalizada: "Finalizada (legado)",
  deployada: "Deployada (legado)", aborted: "Abortada (legado)",
}

/** Cor do Chip MUI para cada status. */
export const TASK_STATUS_COLORS: Record<string, "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning"> = {
  completed: "success", closed: "success", deployed: "success", finalizada: "success", deployada: "success",
  analyzing: "info", running: "info", ready: "info", motor_fix: "info", paused: "warning",
  awaiting_clarification: "warning", awaiting_interaction: "warning", blocked: "error", failed: "error",
  cancelled: "error", aborted: "error", draft: "default", planned: "default",
}

/** Status finais — tarefa não executa mais. */
export const TASK_STATUS_FINAIS = new Set<string>(["completed", "closed", "deployed", "cancelled", "failed", "finalizada", "deployada", "aborted"])
/** Status que permitem ação "start" (iniciar/retomar). */
export const TASK_STATUS_STARTABLE = new Set<string>(["draft", "planned", "blocked", "failed", "paused"])
/** Status em execução ativa (motor trabalhando). */
export const TASK_STATUS_EXECUTING = new Set<string>(["running", "analyzing"])
/** Status que permitem ação "pause" (pausar). */
export const TASK_STATUS_PAUSABLE = new Set<string>(["planned", "analyzing", "awaiting_clarification", "awaiting_interaction", "ready", "running", "motor_fix"])

export const TASK_STATUS_OPTIONS = ALL_TASK_STATUSES.map((value) => ({
  label: `${TASK_STATUS_LABELS[value] ?? value} (${value})`, value,
}))
export const TASK_STATUS_FILTER_OPTIONS = ALL_TASK_STATUSES.map((value) => ({
  label: TASK_STATUS_LABELS[value] ?? value, value,
}))

// ============================================================================
// SUBTASK STATUS
// ============================================================================

/** Todos os status possíveis de uma subtarefa (fonte canônica). */
export const SUBTASK_STATUSES = ["pending", "delivered", "running", "verifying", "verified", "rejected", "blocked", "completed", "failed", "skipped", "rework", "superseded"] as const
export type SubTaskStatusValue = (typeof SUBTASK_STATUSES)[number]
export const SUBTASK_STATUS_LABELS: Record<string, string> = {
  pending: "Pendente", delivered: "Entregue", running: "Em execução", verifying: "Verificando",
  verified: "Verificada", rejected: "Rejeitada", blocked: "Bloqueada", completed: "Concluída",
  failed: "Falhou", skipped: "Ignorada", rework: "Retrabalho", superseded: "Substituída por revisão",
}
export const SUBTASK_STATUS_COLORS: Record<string, "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning"> = {
  verified: "success", completed: "success", delivered: "info", running: "info", verifying: "warning",
  pending: "default", rework: "warning", rejected: "error", blocked: "error", failed: "error",
  skipped: "default", superseded: "default",
}
export const SUBTASK_STATUS_OPTIONS = SUBTASK_STATUSES.map((value) => ({
  label: `${SUBTASK_STATUS_LABELS[value] ?? value} (${value})`, value,
}))

// ============================================================================
// HELPERS
// ============================================================================

export function taskStatusLabel(status: string): string { return TASK_STATUS_LABELS[status] ?? status }
export function taskStatusColor(status: string): "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning" { return TASK_STATUS_COLORS[status] ?? "default" }
export function subtaskStatusLabel(status: string): string { return SUBTASK_STATUS_LABELS[status] ?? status }
export function subtaskStatusColor(status: string): "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning" { return SUBTASK_STATUS_COLORS[status] ?? "default" }
export function isTaskFinal(status: string): boolean { return TASK_STATUS_FINAIS.has(status) }
export function isTaskStartable(status: string): boolean { return TASK_STATUS_STARTABLE.has(status) }
export function taskStatusesHelperText(): string { return TASK_STATUSES.join(" | ") }
export function subtaskStatusesHelperText(): string { return SUBTASK_STATUSES.join(" | ") }
