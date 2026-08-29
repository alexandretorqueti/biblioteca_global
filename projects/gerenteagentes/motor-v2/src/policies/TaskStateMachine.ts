import type { TaskStatus, SubTaskStatus } from "../shared/types/index.js"

export type TaskTransition =
  | "start_analysis" | "analysis_completed" | "start_execution"
  | "execution_completed" | "subtasks_pending" | "pause" | "resume"
  | "resume_without_plan" | "queue" | "fail" | "cancel"

const taskTransitions: Record<TaskTransition, readonly TaskStatus[]> = {
  start_analysis: ["planned"],
  analysis_completed: ["analyzing"],
  start_execution: ["ready"],
  execution_completed: ["running"],
  subtasks_pending: ["running"],
  pause: ["analyzing", "running"],
  resume: ["paused"],
  resume_without_plan: ["paused"],
  queue: ["paused", "planned"],
  fail: ["analyzing", "running"],
  cancel: ["planned", "analyzing", "ready", "running", "paused", "blocked", "failed"],
}

const subtaskTransitions: Record<SubTaskStatus, readonly SubTaskStatus[]> = {
  pending: ["pending", "running", "blocked"],
  delivered: ["delivered", "running", "verifying", "rejected", "blocked"],
  running: ["running", "verifying", "rejected", "blocked"],
  verifying: ["verifying", "verified", "rejected", "blocked"],
  verified: ["verified"],
  rejected: ["rejected", "pending", "verified", "blocked"],
  blocked: ["blocked", "pending"],
  completed: ["completed"],
  failed: ["failed", "pending"],
  skipped: ["skipped"],
  rework: ["rework", "pending", "running", "blocked"],
}

export function transitionTask(current: TaskStatus, transition: TaskTransition): TaskStatus {
  if (!taskTransitions[transition].includes(current)) {
    throw new Error(`Transição de tarefa inválida: ${current} -> ${transition}`)
  }
  const next: Record<TaskTransition, TaskStatus> = {
    start_analysis: "analyzing",
    analysis_completed: "ready",
    start_execution: "running",
    execution_completed: "completed",
    subtasks_pending: "ready",
    pause: "paused",
    resume: "ready",
    resume_without_plan: "planned",
    queue: "planned",
    fail: "blocked",
    cancel: "cancelled",
  }
  return next[transition]
}

export function assertSubtaskTransition(current: SubTaskStatus, next: SubTaskStatus): void {
  if (!subtaskTransitions[current].includes(next)) {
    throw new Error(`Transição de subtarefa inválida: ${current} -> ${next}`)
  }
}
