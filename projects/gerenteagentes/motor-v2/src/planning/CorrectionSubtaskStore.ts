import type { Db } from "../shared/types/infrastructure.js"
import type { PromotionRecoveryRequest } from "../promotion-gate/PromotionRecoveryPlanner.js"

export interface CorrectionSubtaskStoreResult { created: boolean }

/**
 * Único escritor de corretivas complementares. A verificação apenas monta o
 * pedido; este módulo preserva a regra de sequência, vínculo e idempotência.
 */
export async function createPromotionCorrectionSubtask(
  db: Db,
  taskId: string,
  request: PromotionRecoveryRequest,
): Promise<CorrectionSubtaskStoreResult> {
  return db.transaction(async (tx) => {
    const numeric = /^\d+$/.test(taskId)
    const { rows: tasks } = await tx.query(
      numeric ? "SELECT id FROM tarefas WHERE external_id = ? OR id = ? LIMIT 1 FOR UPDATE" : "SELECT id FROM tarefas WHERE external_id = ? LIMIT 1 FOR UPDATE",
      numeric ? [taskId, taskId] : [taskId],
    )
    const databaseTaskId = Number(tasks[0]?.id ?? 0)
    if (!databaseTaskId) throw new Error("Tarefa não encontrada para criar corretiva: " + taskId)
    const { rows: existing } = await tx.query(
      "SELECT id FROM subtarefas WHERE tarefa_id = ? AND correction_fingerprint = ? LIMIT 1 FOR UPDATE",
      [databaseTaskId, request.fingerprint],
    )
    if (existing.length > 0) return { created: false }
    const { rows: sequenceRows } = await tx.query("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM subtarefas WHERE tarefa_id = ? FOR UPDATE", [databaseTaskId])
    const seq = Number(sequenceRows[0]?.next_seq ?? 1)
    await tx.query(
      "INSERT INTO subtarefas (tarefa_id, seq, titulo, scope, acceptance_criteria, status, correction_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, NOW(), NOW())",
      [databaseTaskId, seq, request.title, request.scope, JSON.stringify(request.acceptanceCriteria), request.fingerprint],
    )
    return { created: true }
  })
}
