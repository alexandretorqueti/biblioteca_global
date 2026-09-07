/**
 * Contrato versionado do evento de execução.
 *
 * Os IDs de task/subtask são IDs internos e imutáveis do banco. O contrato
 * deliberadamente não aceita o identificador textual exibido ao usuário
 * (por exemplo, "st-1") como chave de entidade.
 */

export const EXECUTION_EVENT_SCHEMA_VERSION = 1 as const

export type ExecutionEventSchemaVersion = typeof EXECUTION_EVENT_SCHEMA_VERSION
export type ExecutionEventId = string
export type TaskId = number
export type SubtaskId = number
export type AttemptId = number

export const EXECUTION_EVENT_TYPES = [
  "task_status_changed",
  "subtask_status_changed",
  "attempt_started",
  "attempt_finished",
  "gate_started",
  "gate_finished",
  "delivery_started",
  "delivery_rejected",
  "delivery_accepted",
  "block_opened",
  "block_resolved",
  "execution_paused",
  "execution_resumed",
  "deploy_requested",
  "deploy_started",
  "deploy_finished",
  "smoke_test_started",
  "smoke_test_finished",
] as const

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number]

/** Códigos estáveis para agregações; a mensagem humana fica no payload. */
export const EXECUTION_REASON_CODES = [
  "manual",
  "scheduler",
  "worker_started",
  "worker_completed",
  "worker_failed",
  "worker_exit",
  "cancelled",
  "timeout",
  "lease_lost",
  "gate_passed",
  "gate_failed",
  "rework",
  "blocked_environment",
  "systemic_failure",
  "integration_conflict",
  "clarification_required",
  "clarification_answered",
  "deploy_requested",
  "deploy_succeeded",
  "deploy_failed",
  "smoke_test_passed",
  "smoke_test_failed",
  "smoke_test_not_run",
  "superseded",
] as const

export type ExecutionReasonCode = (typeof EXECUTION_REASON_CODES)[number]

export type ExecutionActorType = "motor" | "worker" | "agent" | "human" | "system"

export type ExecutionStatus =
  | "pending"
  | "running"
  | "verifying"
  | "verified"
  | "rejected"
  | "blocked"
  | "superseded"
  | "deployed"

export interface ExecutionEventPayload {
  /** Resumo sanitizado, sem segredos, stack trace ou saída integral de comando. */
  summary?: string
  /** Campos pequenos e estáveis para auditoria e agregação. */
  attributes?: Readonly<Record<string, string | number | boolean | null>>
}

export interface ExecutionEvent {
  schema_version: ExecutionEventSchemaVersion
  event_id: ExecutionEventId
  occurred_at: string
  task_id: TaskId
  subtask_id: SubtaskId
  attempt_id: AttemptId | null
  event_type: ExecutionEventType
  from_status: ExecutionStatus | null
  to_status: ExecutionStatus | null
  actor_type: ExecutionActorType
  agent_id: string | null
  model: string | null
  execution_id: string | null
  workspace_commit: string | null
  reason_code: ExecutionReasonCode | null
  correlation_id: string
  payload: ExecutionEventPayload
}

const EVENT_TYPES = new Set<string>(EXECUTION_EVENT_TYPES)
const REASON_CODES = new Set<string>(EXECUTION_REASON_CODES)

/** Validação mínima antes de inserir o evento no armazenamento. */
export function assertExecutionEvent(event: ExecutionEvent): void {
  if (event.schema_version !== EXECUTION_EVENT_SCHEMA_VERSION) throw new Error("execution_event: schema_version inválido")
  if (!event.event_id || !event.correlation_id) throw new Error("execution_event: IDs de auditoria são obrigatórios")
  if (!Number.isInteger(event.task_id) || event.task_id <= 0) throw new Error("execution_event: task_id deve ser FK interna")
  if (!Number.isInteger(event.subtask_id) || event.subtask_id <= 0) throw new Error("execution_event: subtask_id deve ser FK interna")
  if (!EVENT_TYPES.has(event.event_type)) throw new Error("execution_event: event_type inválido")
  if (event.reason_code !== null && !REASON_CODES.has(event.reason_code)) throw new Error("execution_event: reason_code inválido")
}
