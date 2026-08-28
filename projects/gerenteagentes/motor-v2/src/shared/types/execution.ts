/**
 * Tipos de execucao - contexto, input/output do worker, resultados
 */

import type { Task } from "./index.js"

/** Fases do pipeline de execucao */
export type ExecutionPhase =
  | "prepare"
  | "analyze"
  | "execute"
  | "verify"
  | "deploy"
  | "deliver"

/** Informacoes de subtarefa */
export interface SubtaskInfo {
  id: number
  seq: number
  titulo: string
  scope?: string
  acceptanceCriteria?: string[]
}

/** Contexto de execucao isolado */
export interface ExecutionContext {
  executionId: string
  taskId: string
  projectSlug: string | null
  phase: ExecutionPhase
  fencingToken: number
  startedAt: Date
  subtaskId?: string
  reworkCount?: number
  modelId?: string
}

/** Resultado de execucao */
export interface ExecutionResult {
  ok: boolean
  reason?: string
  subtaskResults?: SubTaskResult[]
}

/** Resultado de uma subtarefa */
export interface SubTaskResult {
  subtaskId: string
  status: "completed" | "failed" | "skipped"
  reason?: string
  durationMs?: number
}

/** Input enviado ao Worker */
export interface WorkerInput {
  context: ExecutionContext
  task: Task
  repoPath: string
  buildCommand: string
  testCommand: string
  subtask?: SubtaskInfo
  workBranch?: string
}

/** Output retornado pelo Worker */
export interface WorkerOutput {
  executionId: string
  taskId: string
  result: ExecutionResult
}
