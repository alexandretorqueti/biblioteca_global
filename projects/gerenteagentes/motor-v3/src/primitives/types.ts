/**
 * Tipos base para primitivas
 */

export interface PrimitiveContext {
  taskId: string
  subtaskId?: number
  executionId: string
  generation: number
  projectSlug: string
  repoPath: string
  worktreePath: string
  branchName: string
  sessionId?: string
  agentId: string
  db: any // Drizzle DB instance
  consoleApi?: any // Console API client
  logger?: any // Logger instance
}

export interface PrimitiveResult {
  success: boolean
  error?: string
  data?: any
}

export type PrimitiveHandler = (
  context: PrimitiveContext,
  params?: Record<string, any>
) => Promise<PrimitiveResult>

export interface PrimitiveDefinition {
  code: string
  name: string
  domain: 'session' | 'model' | 'git' | 'db' | 'queue' | 'control'
  handler: PrimitiveHandler
}
