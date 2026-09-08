import type { AnyTaskStatus } from "../shared/task-statuses.js"

export type TaskTransitionActor = "user" | "motor"

export type TaskTransitionAuthorization = {
  allowed: boolean
  reason: "allowed" | "reserved_for_motor" | "transition_not_allowed"
}

/** Matriz única de autorização para mudanças de status persistidas. */
const MOTOR_DESTINATIONS: Partial<Record<AnyTaskStatus, readonly AnyTaskStatus[]>> = {
  draft: ["planned", "analyzing", "ready", "running"],
  planned: ["analyzing", "blocked", "cancelled"],
  analyzing: ["ready", "awaiting_clarification", "paused", "blocked", "cancelled"],
  awaiting_clarification: ["planned", "blocked", "cancelled"],
  ready: ["running", "completed", "blocked", "cancelled"],
  running: ["completed", "ready", "paused", "blocked", "cancelled"],
  paused: ["ready", "planned", "blocked", "cancelled"],
  completed: ["deployed"],
  blocked: ["cancelled"],
  failed: ["cancelled"],
}

/**
 * Usuários devem usar as operações próprias (start/pause/resume/deploy), que
 * encaminham a intenção ao Motor. O no-op é permitido para drops na mesma
 * estação; qualquer mudança real é reservada ao Motor.
 */
export function authorizeTaskStatusTransition(
  from: AnyTaskStatus,
  to: AnyTaskStatus,
  actor: TaskTransitionActor,
): TaskTransitionAuthorization {
  if (from === to) return { allowed: true, reason: "allowed" }
  if (!(MOTOR_DESTINATIONS[from]?.includes(to) ?? false)) {
    return { allowed: false, reason: "transition_not_allowed" }
  }
  if (actor === "user") return { allowed: false, reason: "reserved_for_motor" }
  return { allowed: true, reason: "allowed" }
}

export function isTaskStatusTransitionAllowed(
  from: AnyTaskStatus,
  to: AnyTaskStatus,
  actor: TaskTransitionActor,
): boolean {
  return authorizeTaskStatusTransition(from, to, actor).allowed
}

