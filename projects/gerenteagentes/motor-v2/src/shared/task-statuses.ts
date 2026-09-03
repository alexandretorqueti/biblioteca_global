/**
 * Fonte única de verdade para status de tarefa e subtarefa no GerenteAgentes.
 *
 * Centraliza valores, labels amigáveis, cores e conjuntos auxiliares para que
 * adicionar/remover status exija mudança em um só lugar.
 *
 * Consumidores:
 * - TaskMonitorScreen (combo de filtro, Chip de cor, formulário de edição)
 * - motor-v2/shared/types (TaskStatus / SubTaskStatus)
 * - gerenteagentes.service (validação de transições)
 * - schema.ts (annotations / helperText)
 * - config.ts (options de select, valuesLast)
 */

// ============================================================================
// TASK STATUS
// ============================================================================

/** Todos os status possíveis de uma tarefa (fonte canônica). */
export const TASK_STATUSES = [
  "draft",
  "planned",
  "analyzing",
  "awaiting_clarification",
  "ready",
  "running",
  "paused",
  "completed",
  "deployed",
  "blocked",
  "motor_fix",
  "failed",
  "cancelled",
] as const

export type TaskStatusValue = (typeof TASK_STATUSES)[number]

/**
 * Status legados que podem existir em registros antigos (v1).
 * Mantidos para filtro/visualização, mas o motor-v2 não grava mais.
 */
export const TASK_STATUSES_LEGACY = [
  "finalizada",
  "deployada",
  "aborted",
] as const

export type TaskStatusLegacy = (typeof TASK_STATUSES_LEGACY)[number]

/** União de todos os status de tarefa (atuais + legados). */
export const ALL_TASK_STATUSES = [
  ...TASK_STATUSES,
  ...TASK_STATUSES_LEGACY,
] as const

export type AnyTaskStatus = TaskStatusValue | TaskStatusLegacy

/** Labels amigáveis para cada status de tarefa. */
export const TASK_STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho",
  planned: "Planejada",
  analyzing: "Em análise",
  awaiting_clarification: "Aguardando esclarecimento",
  ready: "Pronta",
  running: "Em execução",
  paused: "Pausada",
  completed: "Concluída",
  deployed: "Deployada",
  blocked: "Bloqueada",
  motor_fix: "Correção do motor",
  failed: "Falhou",
  cancelled: "Cancelada",
  // Legados
  finalizada: "Finalizada (legado)",
  deployada: "Deployada (legado)",
  aborted: "Abortada (legado)",
}

/** Cor do Chip MUI para cada status. */
export const TASK_STATUS_COLORS: Record<
  string,
  "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning"
> = {
  // Sucesso (finalizados com êxito)
  completed: "success",
  deployed: "success",
  finalizada: "success",
  deployada: "success",
  // Informação (em andamento)
  analyzing: "info",
  running: "info",
  ready: "info",
  motor_fix: "info",
  // Aviso (pausada / aguardando)
  paused: "warning",
  awaiting_clarification: "warning",
  // Erro (falha / bloqueio)
  blocked: "error",
  failed: "error",
  cancelled: "error",
  aborted: "error",
  // Default
  draft: "default",
  planned: "default",
}

/** Status finais — tarefa não executa mais. */
export const TASK_STATUS_FINAIS = new Set<string>([
  "completed",
  "deployed",
  "cancelled",
  "failed",
  // Legados
  "finalizada",
  "deployada",
  "aborted",
])

/** Status que permitem ação "start" (iniciar/retomar). */
export const TASK_STATUS_STARTABLE = new Set<string>([
  "draft",
  "planned",
  "blocked",
  "failed",
  "paused",
])

/** Status em execução ativa (motor trabalhando). */
export const TASK_STATUS_EXECUTING = new Set<string>([
  "running",
  "analyzing",
])

/**
 * Opções para combos/select de status de tarefa.
 * Array de { label, value } pronto para uso em DynamicForm e Select.
 */
export const TASK_STATUS_OPTIONS = ALL_TASK_STATUSES.map((value) => ({
  label: `${TASK_STATUS_LABELS[value] ?? value} (${value})`,
  value,
}))

/**
 * Opções para combo de filtro (inclui "Todos" como valor vazio).
 */
export const TASK_STATUS_FILTER_OPTIONS = ALL_TASK_STATUSES.map((value) => ({
  label: TASK_STATUS_LABELS[value] ?? value,
  value,
}))

// ============================================================================
// SUBTASK STATUS
// ============================================================================

/** Todos os status possíveis de uma subtarefa (fonte canônica). */
export const SUBTASK_STATUSES = [
  "pending",
  "delivered",
  "running",
  "verifying",
  "verified",
  "rejected",
  "blocked",
  "completed",
  "failed",
  "skipped",
  "rework",
] as const

export type SubTaskStatusValue = (typeof SUBTASK_STATUSES)[number]

/** Labels amigáveis para cada status de subtarefa. */
export const SUBTASK_STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  delivered: "Entregue",
  running: "Em execução",
  verifying: "Verificando",
  verified: "Verificada",
  rejected: "Rejeitada",
  blocked: "Bloqueada",
  completed: "Concluída",
  failed: "Falhou",
  skipped: "Ignorada",
  rework: "Retrabalho",
}

/** Cor do Chip MUI para cada status de subtarefa. */
export const SUBTASK_STATUS_COLORS: Record<
  string,
  "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning"
> = {
  verified: "success",
  completed: "success",
  delivered: "info",
  running: "info",
  verifying: "warning",
  pending: "default",
  rework: "warning",
  rejected: "error",
  blocked: "error",
  failed: "error",
  skipped: "default",
}

/**
 * Opções para combos/select de status de subtarefa.
 */
export const SUBTASK_STATUS_OPTIONS = SUBTASK_STATUSES.map((value) => ({
  label: `${SUBTASK_STATUS_LABELS[value] ?? value} (${value})`,
  value,
}))

// ============================================================================
// HELPERS
// ============================================================================

/** Retorna o label amigável de um status de tarefa. */
export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status
}

/** Retorna a cor do Chip para um status de tarefa. */
export function taskStatusColor(
  status: string,
): "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning" {
  return TASK_STATUS_COLORS[status] ?? "default"
}

/** Retorna o label amigável de um status de subtarefa. */
export function subtaskStatusLabel(status: string): string {
  return SUBTASK_STATUS_LABELS[status] ?? status
}

/** Retorna a cor do Chip para um status de subtarefa. */
export function subtaskStatusColor(
  status: string,
): "default" | "primary" | "secondary" | "error" | "info" | "success" | "warning" {
  return SUBTASK_STATUS_COLORS[status] ?? "default"
}

/** Verifica se o status de tarefa é final. */
export function isTaskFinal(status: string): boolean {
  return TASK_STATUS_FINAIS.has(status)
}

/** Verifica se a tarefa pode ser iniciada. */
export function isTaskStartable(status: string): boolean {
  return TASK_STATUS_STARTABLE.has(status)
}

/**
 * String helper para annotations/helperText do schema.
 * Ex.: "draft | planned | analyzing | ..."
 */
export function taskStatusesHelperText(): string {
  return TASK_STATUSES.join(" | ")
}

export function subtaskStatusesHelperText(): string {
  return SUBTASK_STATUSES.join(" | ")
}
