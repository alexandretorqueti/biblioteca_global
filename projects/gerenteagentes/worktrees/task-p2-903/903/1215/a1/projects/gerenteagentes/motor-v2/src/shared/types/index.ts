/**
 * Tipos principais do Motor v2
 *
 * Status de tarefa e subtarefa são definidos em ./task-statuses.ts
 * (fonte única de verdade) e re-exportados aqui como types para uso no motor.
 */
import type { TaskStatusValue, SubTaskStatusValue } from "../task-statuses.js"

/** Status possíveis de uma tarefa (fonte: shared/task-statuses.ts) */
export type TaskStatus = TaskStatusValue

/** Status possíveis de uma subtarefa (fonte: shared/task-statuses.ts) */
export type SubTaskStatus = SubTaskStatusValue

/** Fluxo operacional da tarefa. Tarefas antigas são tratadas como desenvolvimento. */
export type TaskTipo = "desenvolvimento" | "automacao" | "verificacao"

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
  tipo?: TaskTipo
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
