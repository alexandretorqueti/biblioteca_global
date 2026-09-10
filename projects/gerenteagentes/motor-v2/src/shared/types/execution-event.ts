/**
 * Contrato canônico dos eventos de execução persistíveis.
 *
 * Os identificadores de tarefa, subtarefa e tentativa são chaves imutáveis do
 * banco (não external_id, seq ou qualquer outro identificador textual). O
 * execution_id identifica a execução do Motor; correlation_id agrupa eventos
 * de uma mesma operação, inclusive operações de deploy sem worker ativo.
 */

export const EXECUTION_EVENT_TYPES = [
  "task_started",
  "task_paused",
  "task_resumed",
  "task_failed",
  "task_completed",
  "subtask_started",
  "subtask_retried",
  "subtask_delivered",
  "subtask_verified",
  "subtask_rejected",
  "subtask_blocked",
  "subtask_superseded",
  "gate_started",
  "gate_passed",
  "gate_failed",
  "blocker_opened",
  "blocker_resolved",
  "integration_conflict",
  "deploy_requested",
  "deploy_started",
  "deploy_succeeded",
  "deploy_failed",
  "smoke_test_passed",
  "smoke_test_failed",
  "execution_cancelled",
  "execution_error",
] as const

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number]

/** Quem produziu a mudança observada. */
export const EXECUTION_ACTOR_TYPES = ["motor", "agent", "human", "system"] as const
export type ExecutionActorType = (typeof EXECUTION_ACTOR_TYPES)[number]

/** Códigos estáveis para agrupamento de falhas e bloqueios. */
export const EXECUTION_REASON_CODES = [
  "manual",
  "worker_started",
  "retry_after_rejection",
  "gate_passed",
  "gate_failed",
  "blocked_environment",
  "systemic_failure",
  "model_chain_exhausted",
  "correction_failed",
  "integration_conflict",
  "timeout",
  "lease_lost",
  "lease_expired",
  "cancelled",
  "paused",
  "resumed",
  "deploy_requested",
  "deploy_succeeded",
  "deploy_failed",
  "smoke_test_passed",
  "smoke_test_failed",
  "invalid_transition",
] as const
export type ExecutionReasonCode = (typeof EXECUTION_REASON_CODES)[number]

/**
 * Status que podem aparecer nas transições auditadas.
 *
 * ⚠️ `deployada` é legado (v1). Pode existir em eventos históricos, mas
 * novas gravações DEVEM usar `deployed`. Leituras normalizam via
 * `normalizeTaskStatus()` em `status-normalization.ts`.
 */
export const EXECUTION_STATUSES = [
  "pending", "running", "verifying", "verified", "rejected", "blocked",
  "superseded", "deployed", "deployada",
  "draft", "planned", "analyzing", "awaiting_clarification", "ready",
  "paused", "completed", "failed", "cancelled",
] as const
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]

/**
 * Status canônicos para novas gravações de eventos.
 * Exclui legados (`deployada`). Usar este tipo para validar transições
 * antes de gravar um evento.
 */
export const EXECUTION_WRITABLE_STATUSES: readonly string[] = [
  "pending", "running", "verifying", "verified", "rejected", "blocked",
  "superseded", "deployed",
  "draft", "planned", "analyzing", "awaiting_clarification", "ready",
  "paused", "completed", "failed", "cancelled",
] as const

export interface ExecutionEvent {
  event_id: string
  occurred_at: Date
  task_id: number
  subtask_id: number | null
  attempt_id: number | null
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
}
