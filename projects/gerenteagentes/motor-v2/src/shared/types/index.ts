/**
 * Tipos fundamentais do Motor v2
 * Zero `any` - todos os tipos são explícitos
 */

export type TaskStatus =
  | 'draft'
  | 'planned'
  | 'planning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'finalizada'
  | 'deployada'
  | 'blocked'

export type SubTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'failed'

export type ExecutionPhase =
  | 'prepare'
  | 'plan'
  | 'execute'
  | 'integrate'
  | 'deploy'
  | 'finalize'

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
  baselineMode: 'full' | 'build_only' | 'skip'
  status: TaskStatus
  maxRework: number
  hardTimeoutMs: number
  dependsOnTaskId?: string
  projectSlug: string | null
  analysisCommit?: string
  executionId?: string
  fencingToken?: number
  createdAt: string
  updatedAt: string
}

export interface SubTask {
  id: string
  taskId: string
  title: string
  description: string
  status: SubTaskStatus
  attempt: number
  maxRework: number
  skipGate: boolean
  dependsOnSubtaskIds: string[]
  workBranch?: string
  workspacePath?: string
  lastCommit?: string
  createdAt: string
  updatedAt: string
}

export interface Project {
  slug: string
  repoPath: string
  workBranch: string
  remoteName: string
  agentId: string
  description?: string
  ativo: boolean
}

export interface ModelConfig {
  tier: string
  provider: string
  model: string
  thinking?: 'low' | 'medium' | 'high'
}

export interface ModelChain {
  chain: ModelConfig[]
  enabled: boolean
  sessionRotateAfter: number
}
