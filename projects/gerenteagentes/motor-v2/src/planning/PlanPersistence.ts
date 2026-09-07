import type { Db } from "../shared/types/infrastructure.js"

export interface PlannedSubtask {
  seq: number
  titulo: string
  scope: string
  acceptanceCriteria: string[]
  deliverables: string[]
  requirementsCovered: string[]
  dependsOn: number[]
}

export interface PlanRequirement {
  id: string
  description: string
}

export interface PlanCoverage {
  requirements: PlanRequirement[]
  coverage: Array<{ requirement: string; coveredBy: number[] }>
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
  coverage: PlanCoverage,
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

    const subtaskIds = new Map<number, number>()
    for (const subtask of subtasks) {
      await tx.query(
        "INSERT INTO subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, deliverables, requirements_covered, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW())",
        [databaseTaskId, subtask.seq, subtask.titulo, subtask.scope, JSON.stringify(subtask.acceptanceCriteria), JSON.stringify(subtask.deliverables), JSON.stringify(subtask.requirementsCovered)],
      )
      const result = await tx.query("SELECT LAST_INSERT_ID() AS id")
      subtaskIds.set(subtask.seq, Number(result.rows[0]?.id ?? 0))
    }
    for (const subtask of subtasks) {
      for (const dependencySeq of subtask.dependsOn) {
        await tx.query("UPDATE subtarefas SET depends_on_subtask_id = ? WHERE tarefa_id = ? AND seq = ?", [subtaskIds.get(dependencySeq) ?? null, databaseTaskId, subtask.seq])
      }
    }
    await tx.query("UPDATE tarefas SET plan_coverage = ? WHERE id = ?", [JSON.stringify(coverage), databaseTaskId])
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
