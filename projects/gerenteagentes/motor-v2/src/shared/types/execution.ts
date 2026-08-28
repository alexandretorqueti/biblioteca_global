/**
 * Tipos de execução - contexto, input/output do worker, resultados
 */

import type { Task } from './index.js'

/** Fases do pipeline de execução */
export type ExecutionPhase =
  | 'prepare'
  | 'analyze'
  | 'execute'
  | 'verify'
  | 'deliver'

/** Contexto de execução isolado (propagado via AsyncLocalStorage) */
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

/** Resultado de execução */
export interface ExecutionResult {
  ok: boolean
  reason?: string
  subtaskResults?: SubTaskResult[]
}

/** Resultado de uma subtarefa */
export interface SubTaskResult {
  subtaskId: string
  status: 'completed' | 'failed' | 'skipped'
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
}

/** Output retornado pelo Worker */
export interface WorkerOutput {
  executionId: string
  taskId: string
  result: ExecutionResult
}

/** Cria um novo ExecutionContext */
export function createExecutionContext(
  taskId: string,
  projectSlug: string | null,
  fencingToken: number
): ExecutionContext {
  return {
    executionId: `exec-${taskId}-${Date.now()}`,
    taskId,
    projectSlug,
    phase: 'prepare',
    fencingToken,
    startedAt: new Date(),
  }
}
