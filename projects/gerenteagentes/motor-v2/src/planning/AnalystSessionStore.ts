import type { Db } from "../shared/types/infrastructure.js"

export interface TaskAnalystSession {
  id: number
  taskDatabaseId: number
  agentId: string
  model: string
  sessionKey: string
  runtimeSessionId?: string
  status: string
}

function taskLookup(taskId: string): { sql: string; params: unknown[] } {
  if (/^\d+$/.test(taskId)) return { sql: "SELECT id FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1", params: [taskId, taskId] }
  return { sql: "SELECT id FROM tarefas WHERE external_id = ? LIMIT 1", params: [taskId] }
}

async function resolveTaskId(db: Db, taskId: string): Promise<number> {
  const result = await db.query(taskLookup(taskId).sql, taskLookup(taskId).params)
  const id = Number(result.rows[0]?.id ?? 0)
  if (!id) throw new Error("Tarefa não encontrada: " + taskId)
  return id
}

function mapRow(row: Record<string, unknown>): TaskAnalystSession {
  return { id: Number(row.id), taskDatabaseId: Number(row.tarefa_id), agentId: String(row.agent_id), model: String(row.model), sessionKey: String(row.session_key), runtimeSessionId: row.runtime_session_id == null ? undefined : String(row.runtime_session_id), status: String(row.status) }
}

/** Reserva antes do runtime; uma retomada relembra a mesma chave mesmo após crash. */
export async function getOrReserveTaskAnalystSession(db: Db, taskId: string, input: { agentId: string; model: string; sessionKey: string }): Promise<TaskAnalystSession> {
  const databaseTaskId = await resolveTaskId(db, taskId)
  await db.query("INSERT IGNORE INTO motor_task_analyst_sessions (tarefa_id, agent_id, model, session_key, status, opened_at, last_activity_at) VALUES (?, ?, ?, ?, 'active', NOW(), NOW())", [databaseTaskId, input.agentId, input.model, input.sessionKey])
  const result = await db.query("SELECT id, tarefa_id, agent_id, model, session_key, runtime_session_id, status FROM motor_task_analyst_sessions WHERE tarefa_id = ? LIMIT 1", [databaseTaskId])
  if (!result.rows[0]) throw new Error("Não foi possível reservar sessão do analista para a tarefa " + taskId)
  return mapRow(result.rows[0])
}

export async function touchTaskAnalystSession(db: Db, sessionId: number, runtimeSessionId?: string): Promise<void> {
  await db.query("UPDATE motor_task_analyst_sessions SET runtime_session_id = COALESCE(?, runtime_session_id), last_activity_at = NOW(), updated_at = NOW() WHERE id = ?", [runtimeSessionId ?? null, sessionId])
}
