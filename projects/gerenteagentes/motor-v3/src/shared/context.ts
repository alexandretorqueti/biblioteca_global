/**
 * MotorContext — contexto passado para primitivas
 *
 * Contém informações sobre a tarefa, subtarefa, sessão, modelo, etc.
 * Usado por ActionExecutor ao executar primitivas.
 */

export interface MotorContext {
  taskId: string
  subtaskId: number | null
  executionId: string
  generation: number

  // Sessão
  sessionId?: string
  sessionKey?: string

  // Modelo
  model?: string
  modelProvider?: string

  // Git
  worktreePath?: string
  repoPath?: string
  branch?: string
  commitHash?: string

  // Erro original (se houver)
  errorCode?: string
  errorMessage?: string
  errorStack?: string
  actionResult?: string

  // Metadados adicionais
  metadata?: Record<string, any>
}

/**
 * Cria contexto mínimo para testes.
 */
export function createTestContext(overrides?: Partial<MotorContext>): MotorContext {
  return {
    taskId: 'test-task',
    subtaskId: null,
    executionId: 'test-exec',
    generation: 1,
    ...overrides,
  }
}
