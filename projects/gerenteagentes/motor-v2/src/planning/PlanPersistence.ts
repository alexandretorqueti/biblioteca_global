import type { Db } from "../shared/types/infrastructure.js"

export interface PlannedSubtask {
  seq: number
  titulo: string
  scope?: string
  acceptanceCriteria?: string[]
}

export type PersistPlanResult = "created" | "already_persisted"

function taskLookup(taskId: string): { sql: string; params: unknown[] } {
  if (/^\d+$/.test(taskId)) {
    return {
      sql: "SELECT id FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1 FOR UPDATE",
      params: [taskId, taskId],
    }
  }
  return {
    sql: "SELECT id FROM tarefas WHERE external_id = ? LIMIT 1 FOR UPDATE",
    params: [taskId],
  }
}

/**
 * Persiste o plano como uma unidade atômica. Um plano existente nunca é
 * apagado: isso torna a operação idempotente e protege a retomada após crash.
 */
export async function persistPlan(
  db: Db,
  taskId: string,
  subtasks: readonly PlannedSubtask[],
): Promise<PersistPlanResult> {
  if (subtasks.length === 0) throw new Error("Plano sem subtarefas")

  return db.transaction(async (tx) => {
    const task = taskLookup(taskId)
    const { rows: taskRows } = await tx.query(task.sql, task.params)
    const databaseTaskId = Number(taskRows[0]?.id ?? 0)
    if (!databaseTaskId) throw new Error("Tarefa não encontrada: " + taskId)

    const { rows: existing } = await tx.query(
      "SELECT id FROM subtarefas WHERE tarefa_id = ? LIMIT 1 FOR UPDATE",
      [databaseTaskId],
    )
    if (existing.length > 0) return "already_persisted"

    for (const subtask of subtasks) {
      await tx.query(
        "INSERT INTO subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', NOW(), NOW())",
        [databaseTaskId, subtask.seq, subtask.titulo, subtask.scope || null, subtask.acceptanceCriteria ? JSON.stringify(subtask.acceptanceCriteria) : null],
      )
    }
    return "created"
  })
}

/** Consulta leve usada antes de chamar o analista para não replanejar. */
export async function hasPersistedPlan(db: Db, taskId: string): Promise<boolean> {
  const isNumeric = /^\d+$/.test(taskId)
  const { rows } = await db.query(
    isNumeric
      ? "SELECT EXISTS(SELECT 1 FROM subtarefas s INNER JOIN tarefas t ON t.id = s.tarefa_id WHERE t.external_id = ? OR t.id = ?) AS has_plan"
      : "SELECT EXISTS(SELECT 1 FROM subtarefas s INNER JOIN tarefas t ON t.id = s.tarefa_id WHERE t.external_id = ?) AS has_plan",
    isNumeric ? [taskId, taskId] : [taskId],
  )
  return Number(rows[0]?.has_plan ?? 0) === 1
}
