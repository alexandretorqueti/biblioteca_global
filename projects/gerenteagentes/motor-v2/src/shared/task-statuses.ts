/**
 * Fonte única de verdade para status de tarefa e subtarefa no GerenteAgentes.
 *
 * Centraliza valores, labels amigáveis, cores e conjuntos auxiliares para que
 * adicionar/remover status exija mudança em um só lugar.
 *
 * ## Taxonomia canônica
 *
 * Este módulo define a taxonomia oficial de estados. Todos os consumidores
 * (APIs, KPIs, dashboard, persistência) DEVEM usar estes valores. Status
 * legados existem apenas para compatibilidade com dados históricos e são
 * normalizados em tempo de leitura por `status-normalization.ts`.
 *
 * ### Semântica dos estados de tarefa
 *
 * | Estado                 | Significado                                                | Avanço |
 * |------------------------|------------------------------------------------------------|--------|
 * | `draft`                | rascunho; não iniciada                                     | 0%     |
 * | `planned`              | planejada, aguardando execução                             | 0%     |
 * | `analyzing`            | analista trabalhando                                       | operacional, não aceito |
 * | `awaiting_clarification` | aguardando resposta do humano                            | 0%     |
 * | `ready`                | pronta para execução                                       | 0%     |
 * | `running`              | execução em curso                                          | operacional, não aceito |
 * | `paused`               | pausada manualmente                                        | 0%     |
 * | `completed`            | concluída com sucesso                                      | 100%   |
 * | `deployed`             | entregue em ambiente; exige smoke test para confiabilidade  | 100% (condicional) |
 * | `blocked`              | impedimento ativo                                          | 0%     |
 * | `motor_fix`            | correção pelo motor                                        | operacional, não aceito |
 * | `failed`               | falhou                                                     | 0%     |
 * | `cancelled`            | cancelada                                                  | 0%     |
 *
 * ### Semântica dos estados de subtarefa
 *
 * | Estado       | Significado                                                  | Avanço |
 * |--------------|--------------------------------------------------------------|--------|
 * | `pending`    | ainda não iniciada; 0%                                       | 0%     |
 * | `running`    | execução em curso; avanço operacional, não aceito             | operacional |
 * | `delivered`  | entrega submetida a gate                                     | operacional |
 * | `verifying`  | gate em execução; não aceito                                 | operacional |
 * | `verified`   | aceite técnico; 100% do peso aceito                          | 100% aceito |
 * | `rejected`   | entrega não aceita; não conta como avanço aceito             | 0%     |
 * | `blocked`    | impedimento ativo; não conta como avanço aceito              | 0%     |
 * | `completed`  | concluída                                                    | 100%   |
 * | `failed`     | falhou                                                       | 0%     |
 * | `skipped`    | ignorada (não elegível)                                      | excluída |
 * | `rework`     | em retrabalho                                                | operacional |
 * | `superseded` | substituída formalmente; excluída do denominador QUANDO a sucessora existir | excluída condicional |
 *
 * Consumidores:
 * - TaskMonitorScreen (combo de filtro, Chip de cor, formulário de edição)
 * - motor-v2/shared/types (TaskStatus / SubTaskStatus)
 * - gerenteagentes.service (validação de transições)
 * - schema.ts (annotations / helperText)
 * - config.ts (options de select, valuesLast)
 * - APIs de métricas/KPIs (normalização em leitura)
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
  "superseded",
] as const

export type SubTaskStatusValue = (typeof SUBTASK_STATUSES)[number]

/**
 * Categoria de avanço para cada status de subtarefa.
 * Usado por KPIs para decidir se um status conta como avanço aceito,
 * operacional, excluído do denominador, etc.
 */
export type SubtaskStatusCategory =
  | "not_started"       // 0%, não iniciada
  | "operational"       // em andamento, não aceito
  | "accepted"          // 100% do peso aceito
  | "excluded"          // excluída do denominador (skipped)
  | "excluded_conditional" // excluída somente se sucessora existir (superseded)

export const SUBTASK_STATUS_CATEGORIES: Record<SubTaskStatusValue, SubtaskStatusCategory> = {
  pending: "not_started",
  running: "operational",
  delivered: "operational",
  verifying: "operational",
  verified: "accepted",
  rejected: "operational",
  blocked: "operational",
  completed: "accepted",
  failed: "operational",
  skipped: "excluded",
  rework: "operational",
  superseded: "excluded_conditional",
}

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
  superseded: "Substituída por revisão",
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
  superseded: "default",
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
