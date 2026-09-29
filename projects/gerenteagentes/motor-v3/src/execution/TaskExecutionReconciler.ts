import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { createQueueMessage, insertOutboxMessage } from '../queue/index.js'

interface TaskRow extends RowDataPacket {
  id: number
  external_id: string | null
  tipo: string | null
  paused_at: Date | string | null
  terminal_status: string | null
  analysis_started_at: Date | string | null
  clarification_pending_at: Date | string | null
  blocked: number | string
  subtask_count: number | string
}

interface SubtaskRow extends RowDataPacket {
  id: number
  seq: number
  titulo: string
  scope: string | null
}

export type ReconciliationResult =
  | { enqueued: true; type: 'TASK_RESUME_REQUESTED' | 'TASK_READY_FOR_PROGRAMMING'; taskId: string }
  | { enqueued: false; reason: string; taskId: string }

/**
 * Recupera tarefas que ficaram elegíveis sem o comando correspondente.
 *
 * A operação é deliberadamente pontual: o boot varre o catálogo e o serviço
 * de tarefas chama reconcileTask após uma mutação. A deduplicação fica na
 * mesma transação que a inserção no outbox, portanto chamadas concorrentes
 * não criam comandos duplicados.
 */
export class TaskExecutionReconciler {
  constructor(private readonly pool: Pool) {}

  async reconcileAll(): Promise<number> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { task_id: string }>>(`
      SELECT COALESCE(
               t.external_id,
               CAST(t.id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
             ) AS task_id
        FROM tarefas t
       WHERE t.paused_at IS NULL
       ORDER BY t.id ASC
    `)
    let enqueued = 0
    for (const row of rows) {
      const result = await this.reconcileTask(String(row.task_id), 'motor_boot')
      if (result.enqueued) enqueued++
    }
    return enqueued
  }

  async reconcileTask(taskId: string, reason = 'task_changed'): Promise<ReconciliationResult> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const task = await this.lockTask(connection, taskId)
      if (!task) return this.finish(connection, { enqueued: false, reason: 'task_not_found', taskId })

      const canonicalTaskId = String(task.external_id ?? task.id)
      if (task.paused_at) return this.finish(connection, { enqueued: false, reason: 'paused', taskId: canonicalTaskId })
      if (task.terminal_status || ['cancelled', 'failed', 'completed'].includes(String(task.terminal_status ?? '').toLowerCase())) {
        return this.finish(connection, { enqueued: false, reason: 'terminal', taskId: canonicalTaskId })
      }
      if (Number(task.blocked) !== 0) return this.finish(connection, { enqueued: false, reason: 'blocked', taskId: canonicalTaskId })

      // Primeiro: verificar se há subtarefa running órfã (sessão failed ou stale)
      const [orphanRunning] = await connection.query<Array<RowDataPacket & { id: number; seq: number; titulo: string }>>(`
        SELECT s.id, s.seq, s.titulo
          FROM subtarefas s
         WHERE s.tarefa_id = ?
           AND s.status = 'running'
           AND s.generation = (
             SELECT MAX(s2.generation) FROM subtarefas s2 WHERE s2.tarefa_id = s.tarefa_id
           )
           AND (
             EXISTS (
               SELECT 1 FROM motor_agent_sessions mas
                WHERE mas.subtarefa_id = s.id
                  AND mas.status = 'failed'
                  AND mas.closed_at IS NOT NULL
             )
             OR NOT EXISTS (
               SELECT 1 FROM motor_agent_sessions mas
                WHERE mas.subtarefa_id = s.id
                  AND mas.status = 'active'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM motor_outbox o
              WHERE o.task_id = ?
                AND o.type IN ('SUBTASK_EXECUTION_REQUESTED', 'SUBTASK_EXECUTION_COMPLETED')
                AND (
                  o.status = 'pending'
                  OR EXISTS (
                    SELECT 1 FROM motor_message_processing_state mps
                     WHERE mps.message_id = o.message_id
                       AND mps.status = 'processing'
                  )
                )
           )
         ORDER BY s.seq ASC
         LIMIT 1
      `, [task.id, canonicalTaskId])

      if (orphanRunning[0]) {
        // Subtarefa running órfã: resetar para pending e reenfileirar
        const duplicate = await this.hasUnfinishedCommand(connection, canonicalTaskId, 'TASK_READY_FOR_PROGRAMMING')
        if (duplicate) {
          // Mesmo com comando pendente, reseta a subtarefa para pending
          // para que o consumer existente possa processá-la
          await connection.query(
            'UPDATE subtarefas SET status = \'pending\' WHERE id = ?',
            [orphanRunning[0].id]
          )
          return this.finish(connection, { enqueued: false, reason: 'command_already_pending', taskId: canonicalTaskId })
        }
        await connection.query(
          'UPDATE subtarefas SET status = \'pending\' WHERE id = ?',
          [orphanRunning[0].id]
        )
        const message = createQueueMessage({
          type: 'TASK_READY_FOR_PROGRAMMING',
          taskId: canonicalTaskId,
          executionId: `reconcile-orphan-${orphanRunning[0].id}-${Date.now()}`,
          payload: { reason: 'orphan_running_subtask', subtaskId: Number(orphanRunning[0].id), seq: Number(orphanRunning[0].seq), recovered: true },
        })
        await insertOutboxMessage(connection, message)
        return this.finish(connection, { enqueued: true, type: 'TASK_READY_FOR_PROGRAMMING', taskId: canonicalTaskId })
      }

      const [subtasks] = await connection.query<SubtaskRow[]>(`
        SELECT s.id, s.seq, s.titulo, s.scope
          FROM subtarefas s
         WHERE s.tarefa_id = ?
           AND s.status = 'pending'
           AND s.generation = (
             SELECT MAX(s2.generation) FROM subtarefas s2 WHERE s2.tarefa_id = s.tarefa_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM subtarefas active
              WHERE active.tarefa_id = s.tarefa_id
                AND active.status IN ('running', 'delivered', 'verifying')
           )
           AND NOT EXISTS (
             SELECT 1 FROM motor_agent_sessions active_session
              WHERE active_session.subtarefa_id = s.id
                AND active_session.status = 'active'
           )
           AND NOT EXISTS (
             SELECT 1 FROM subtarefas previous
              WHERE previous.tarefa_id = s.tarefa_id
                AND previous.generation = s.generation
                AND previous.seq < s.seq
                AND previous.status NOT IN ('verified', 'superseded')
                AND previous.id != COALESCE(s.correction_for_subtask_id, -1)
           )
           AND NOT EXISTS (
             SELECT 1 FROM subtarefas dependency
              WHERE JSON_CONTAINS(COALESCE(s.depends_on_subtask_ids, JSON_ARRAY()), CAST(dependency.id AS JSON))
                AND dependency.status NOT IN ('verified', 'superseded')
           )
         ORDER BY s.seq ASC
         LIMIT 1
      `, [task.id])

      const hasSubtasks = Number(task.subtask_count) > 0
      if (subtasks[0]) {
        const duplicate = await this.hasUnfinishedCommand(connection, canonicalTaskId, 'TASK_READY_FOR_PROGRAMMING')
        if (duplicate) return this.finish(connection, { enqueued: false, reason: 'command_already_pending', taskId: canonicalTaskId })
        const message = createQueueMessage({
          type: 'TASK_READY_FOR_PROGRAMMING',
          taskId: canonicalTaskId,
          executionId: `reconcile-ready-${canonicalTaskId}-${Date.now()}`,
          payload: { reason, subtaskId: Number(subtasks[0].id), seq: Number(subtasks[0].seq), recovered: true },
        })
        await insertOutboxMessage(connection, message)
        return this.finish(connection, { enqueued: true, type: 'TASK_READY_FOR_PROGRAMMING', taskId: canonicalTaskId })
      }

      // Sem subtarefas, somente uma tarefa sem análise em andamento pode
      // voltar à fila de análise. Tarefas com plano não elegível aguardam
      // dependência/capacidade e não devem gerar mensagens em loop.
      if (hasSubtasks || task.analysis_started_at || task.clarification_pending_at) {
        return this.finish(connection, { enqueued: false, reason: hasSubtasks ? 'no_eligible_subtask' : 'analysis_in_progress', taskId: canonicalTaskId })
      }
      const duplicate = await this.hasUnfinishedCommand(connection, canonicalTaskId, 'TASK_RESUME_REQUESTED')
      if (duplicate) return this.finish(connection, { enqueued: false, reason: 'command_already_pending', taskId: canonicalTaskId })
      const message = createQueueMessage({
        type: 'TASK_RESUME_REQUESTED',
        taskId: canonicalTaskId,
        executionId: `reconcile-analysis-${canonicalTaskId}-${Date.now()}`,
        payload: { reason, recovered: true },
      })
      await insertOutboxMessage(connection, message)
      return this.finish(connection, { enqueued: true, type: 'TASK_RESUME_REQUESTED', taskId: canonicalTaskId })
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async lockTask(connection: PoolConnection, taskId: string): Promise<TaskRow | null> {
    const [rows] = await connection.query<TaskRow[]>(`
      SELECT t.id, t.external_id, t.tipo, t.paused_at,
             f.terminal_status, f.analysis_started_at, f.clarification_pending_at,
             EXISTS(SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS blocked,
             (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id) AS subtask_count
        FROM tarefas t
        LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
       WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
       LIMIT 1 FOR UPDATE
    `, [taskId, taskId])
    return rows[0] ?? null
  }

  private async hasUnfinishedCommand(connection: PoolConnection, taskId: string, type: string): Promise<boolean> {
    const [rows] = await connection.query<Array<RowDataPacket & { total: number | string }>>(`
      SELECT COUNT(*) AS total
        FROM motor_outbox o
       WHERE o.type = ?
         AND (o.task_id = ? OR o.task_id = CAST((SELECT id FROM tarefas WHERE external_id = ? LIMIT 1) AS CHAR))
         AND (
           o.status IN ('pending', 'published')
           OR EXISTS (
             SELECT 1 FROM motor_message_processing_state mps
              WHERE mps.message_id = o.message_id
                AND mps.status IN ('processing', 'completed')
           )
         )
    `, [type, taskId, taskId])
    return Number(rows[0]?.total ?? 0) > 0
  }

  private async finish(connection: PoolConnection, result: ReconciliationResult): Promise<ReconciliationResult> {
    await connection.commit()
    return result
  }
}
