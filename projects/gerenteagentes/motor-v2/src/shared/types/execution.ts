/**
 * Tipos de execucao - contexto, input/output do worker, resultados
 */

import type { Task } from "./index.js"
import type { ModelPhase, ModelSelection } from "../../policies/ModelTierPolicy.js"

/** Fases do pipeline de execucao */
export type ExecutionPhase =
  | "prepare"
  | "analyze"
  | "execute"
  | "verify"
  | "commit"
  | "publish"
  | "deploy"
  | "deliver"

/** Informacoes de subtarefa */
export interface SubtaskInfo {
  id: number
  seq: number
  titulo: string
  scope?: string
  acceptanceCriteria?: string[]
  /** Fingerprint de correção (ex.: "baseline:..." marca correção de baseline). */
  correctionFingerprint?: string | null
  /** Entregas já persistidas antes desta execução ou retomada. */
  deliverCount: number
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
  gitCommitSha?: string
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
  baseBranch?: string
  modelChain?: readonly ModelSelection[]
  modelPhase?: ModelPhase
}

/** Output retornado pelo Worker */
export interface WorkerOutput {
  executionId: string
  taskId: string
  result: ExecutionResult
}
