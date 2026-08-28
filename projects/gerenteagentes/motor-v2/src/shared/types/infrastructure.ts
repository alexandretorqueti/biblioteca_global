/**
 * Tipos de infraestrutura - interfaces para banco de dados e repositórios
 * 
 * Substitui imports de @gerente-agentes/persistence que não existe na biblioteca.
 * Quando o motor-v2 for integrado, estas interfaces serão implementadas
 * usando o schema Drizzle da biblioteca.
 */

/** Resultado de uma query SQL */
export interface QueryResult {
  rows: Record<string, unknown>[]
  affectedRows: number
  insertId: number
}

/** Interface de banco de dados */
export interface Db {
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>
}

/** Task como vem do banco (row) */
export interface TaskRow {
  id: string
  external_id?: string
  chat_id: string
  agent_id: string
  title: string
  description: string
  repo_path: string
  build_command: string
  unit_test_command: string
  status: string
  max_rework: number
  hard_timeout_ms: number
  depends_on_task_id?: string | null
  project_slug?: string | null
  execution_id?: string | null
  error_message?: string | null
  resource_wait_key?: string | null
  resource_wait_position?: number | null
  paused_at?: string | null
  started_at?: string | null
  completed_at?: string | null
  created_at: string
  updated_at: string
}

/** Dados para salvar uma tarefa */
export interface SaveTaskData {
  id: string
  chatId: string
  agentId: string
  title: string
  description: string
  repoPath: string
  buildCommand: string
  unitTestCommand: string
  status: string
  maxRework: number
  hardTimeoutMs: number
  dependsOnTaskId?: string
  projectSlug?: string | null
  executionId?: string
  errorMessage?: string
  startedAt?: string
  completedAt?: string
  updatedAt?: string
  [key: string]: unknown
}

/** Repositório de tarefas */
export interface TaskRepository {
  getTask(id: string): Promise<SaveTaskData | null>
  saveTask(data: SaveTaskData): Promise<void>
}
