/**
 * Tipos de execução e contexto
 */

import type { Task, ExecutionPhase } from './index.js'

export interface ExecutionContext {
  executionId: string
  taskId: string
  projectSlug: string
  phase: ExecutionPhase
  fencingToken: number
  startedAt: Date
  workerId?: string
}

export interface ExecutionResult {
  executionId: string
  outcome: 'completed' | 'blocked' | 'waiting_resource' | 'failed'
  phase: ExecutionPhase
  result?: unknown
  nextPhase?: ExecutionPhase
  resourcesToRelease?: string[]
  error?: string
}

export interface WorkerInput {
  executionId: string
  taskId: string
  projectSlug: string
  phase: ExecutionPhase
  fencingToken: number
  resources: string[]
  task: Task
}

export interface WorkerOutput {
  executionId: string
  outcome: 'completed' | 'blocked' | 'waiting_resource' | 'failed'
  phase: ExecutionPhase
  result?: unknown
  nextPhase?: ExecutionPhase
  resourcesToRelease?: string[]
  error?: string
}

export type WorkerMessage =
  | { type: 'start'; input: WorkerInput }
  | { type: 'cancel'; reason: string }
  | { type: 'shutdown' }

export type CoordinatorMessage =
  | { type: 'started'; executionId: string }
  | { type: 'progress'; executionId: string; phase: ExecutionPhase; message: string }
  | { type: 'waiting_resource'; executionId: string; resourceKey: string; waitId: number }
  | { type: 'completed'; executionId: string; result: ExecutionResult }
  | { type: 'failed'; executionId: string; error: string }
  | { type: 'heartbeat'; executionId: string }

export function createExecutionContext(task: Task, phase: ExecutionPhase = 'prepare'): ExecutionContext {
  const executionId = task.executionId ?? `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  return {
    executionId,
    taskId: task.id,
    projectSlug: task.projectSlug ?? task.agentId,
    phase,
    fencingToken: task.fencingToken ?? 0,
    startedAt: new Date(),
  }
}
