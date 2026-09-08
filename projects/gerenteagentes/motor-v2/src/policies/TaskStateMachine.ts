import type { TaskStatus, SubTaskStatus } from "../shared/types/index.js"

export type TaskTransition =
  | "start_analysis" | "analysis_completed" | "start_execution"
  | "execution_completed" | "deploy_completed" | "subtasks_pending" | "pause" | "resume"
  | "resume_without_plan" | "queue" | "recover" | "fail" | "cancel"
  | "await_clarification" | "clarification_answered"
  | "propose_plan" | "approve_plan" | "request_adjustments"
  | "continue_conversation"

const taskTransitions: Record<TaskTransition, readonly TaskStatus[]> = {
  start_analysis: ["planned"],
  analysis_completed: ["analyzing"],
  // O analista perguntou; a tarefa fica parada aguardando o dono/agente do
  // projeto responder no chat. A resposta a devolve para `planned` (sem
  // subtarefas ainda), de onde o pump a reenvia para análise.
  await_clarification: ["analyzing"],
  clarification_answered: ["awaiting_clarification"],
  // O analista apresentou uma proposta de plano; a tarefa aguarda aprovação
  // explícita do dono antes de criar subtarefas e iniciar execução.
  propose_plan: ["analyzing"],
  approve_plan: ["awaiting_approval"],
  // O dono pediu ajustes; a tarefa volta para `planned` e o pump a reenvia
  // para análise na mesma sessão do analista (contexto preservado).
  request_adjustments: ["awaiting_approval"],
  // O dono quer continuar conversando sobre a proposta sem aprová-la nem
  // pedir ajustes formais. A tarefa volta para `awaiting_clarification`
  // para que o analista responda na mesma sessão (contexto preservado).
  continue_conversation: ["awaiting_approval"],
  start_execution: ["ready"],
  // Entre subtarefas, a tarefa volta para `ready` para que o coordenador
  // possa selecionar a próxima. A última subtarefa pode, portanto, concluir
  // a tarefa tanto a partir de `running` quanto de `ready`.
  execution_completed: ["running", "ready"],
  deploy_completed: ["completed"],
  subtasks_pending: ["running"],
  pause: ["analyzing", "running"],
  resume: ["paused"],
  resume_without_plan: ["paused"],
  queue: ["paused", "planned"],
  recover: ["analyzing", "running"],
  // Uma falha pode chegar depois de a tarefa ter sido pausada por uma
  // interrupção concorrente do worker (por exemplo, o gate termina enquanto
  // o evento de saída do processo é tratado). Nesse caso a falha precisa ser
  // persistida, e não derrubar o coordenador por uma transição inválida.
  // Falhas ambientais podem ocorrer antes de a análise conseguir iniciar
  // (por exemplo, workspace inacessível em uma tarefa `planned`) ou durante a
  // execução com a tarefa ainda `ready`/`running` (repo removido, git ausente).
  fail: ["planned", "analyzing", "awaiting_clarification", "awaiting_approval", "ready", "running", "paused"],
  cancel: ["planned", "analyzing", "awaiting_clarification", "awaiting_approval", "ready", "running", "paused", "blocked", "failed"],
}

const subtaskTransitions: Record<SubTaskStatus, readonly SubTaskStatus[]> = {
  pending: ["pending", "running", "blocked"],
  delivered: ["delivered", "running", "verifying", "rejected", "blocked"],
  running: ["running", "verifying", "rejected", "blocked"],
  verifying: ["verifying", "verified", "rejected", "blocked", "pending"],
  verified: ["verified"],
  rejected: ["rejected", "pending", "verified", "blocked"],
  blocked: ["blocked", "pending"],
  completed: ["completed"],
  failed: ["failed", "pending"],
  skipped: ["skipped"],
  rework: ["rework", "pending", "running", "blocked"],
  superseded: ["superseded"],
}

export function transitionTask(current: TaskStatus, transition: TaskTransition): TaskStatus {
  if (!taskTransitions[transition].includes(current)) {
    throw new Error(`Transição de tarefa inválida: ${current} -> ${transition}`)
  }
  const next: Record<TaskTransition, TaskStatus> = {
    start_analysis: "analyzing",
    analysis_completed: "ready",
    await_clarification: "awaiting_clarification",
    clarification_answered: "planned",
    propose_plan: "awaiting_approval",
    approve_plan: "ready",
    request_adjustments: "planned",
    continue_conversation: "awaiting_clarification",
    start_execution: "running",
    execution_completed: "completed",
    deploy_completed: "deployed",
    subtasks_pending: "ready",
    pause: "paused",
    resume: "ready",
    resume_without_plan: "planned",
    queue: "planned",
    recover: "paused",
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
