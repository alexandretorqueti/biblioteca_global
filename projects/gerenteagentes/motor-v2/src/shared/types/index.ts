/**
 * Tipos principais do Motor v2
 */

/** Status possíveis de uma tarefa */
export type TaskStatus =
  | 'planned'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Status possíveis de uma subtarefa */
export type SubTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'rework'

/** Configuração de modelo */
export interface ModelConfig {
  id: string
  provider: string
  model: string
  maxTokens: number
  temperature: number
  timeoutMs: number
}

/** Cadeia de modelos (escalada) */
export interface ModelChain {
  steps: ModelConfig[]
  currentStep: number
}

/** Projeto */
export interface Project {
  slug: string
  name: string
  repoPath: string
  agentId: string
  buildCommand: string
  testCommand: string
  maxRework: number
  hardTimeoutMs: number
}

/** Tarefa */
export interface Task {
  id: string
  chatId: string
  agentId: string
  title: string
  description: string
  repoPath: string
  buildCommand: string
  unitTestCommand: string
  unitTestExclude: string[]
  baselineMode: 'full' | 'incremental'
  status: TaskStatus
  maxRework: number
  hardTimeoutMs: number
  dependsOnTaskId?: string
  projectSlug: string | null
  createdAt: string
  updatedAt: string
  executionId?: string
  errorMessage?: string
  startedAt?: string
  completedAt?: string
}

/** Subtarefa */
export interface SubTask {
  id: string
  taskId: string
  title: string
  description: string
  status: SubTaskStatus
  order: number
  maxRework: number
  reworkCount: number
  skipGate: boolean
  createdAt: string
  updatedAt: string
}
