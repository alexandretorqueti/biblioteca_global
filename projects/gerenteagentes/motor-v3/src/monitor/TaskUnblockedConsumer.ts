import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from '../queue/index.js'
import { createQueueMessage, insertOutboxMessage } from '../queue/index.js'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import { TASK_UNBLOCKED_EVENT_TYPE, type TaskUnblockedPayload } from './TaskBlockedEvent.js'

/** Motivos de bloqueio cuja retomada é refazer o deploy da tarefa. */
const DEPLOY_BLOCK_REASONS = new Set([
  'deploy_failed',
  'pre_deploy_gate_failed',
  'deploy_preparation_failed',
])

/**
 * Retomada automática após desbloqueio — o elo que faltava no incidente da
 * tarefa 886: desbloquear sem retomar deixava a tarefa "concluída" para
 * sempre sem deploy.
 *
 * Consome `TASK_UNBLOCKED` e devolve a tarefa ao curso normal:
 * - bloqueios de deploy → pedidos `failed` voltam a `pending` e um
 *   `DEPLOY_BATCH_DISPATCH_REQUESTED` é enfileirado (mesma transação);
 * - `analysis_failed` → `TASK_RESUME_REQUESTED` para o TaskCoordinator
 *   reabrir a análise (claim atômico já protege contra duplicidade);
 * - demais motivos → apenas auditoria (o fluxo normal já sabe retomar).
 *
 * Idempotente: redelivery não duplica dispatch (UPDATE ... WHERE status='failed'
 * não re-reseta pedidos já retomados; dispatch de pending é deduplicado pelo
 * claim de lote do DeployConsumer).
 */
export class TaskUnblockedConsumer {
  constructor(
    private readonly pool: Pool,
    private readonly events: TaskEventSink,
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== TASK_UNBLOCKED_EVENT_TYPE) return
    const payload = (message.payload ?? {}) as Partial<TaskUnblockedPayload>
    const databaseTaskId = payload.databaseTaskId != null ? Number(payload.databaseTaskId) : await this.resolveDatabaseTaskId(message.taskId)
    if (databaseTaskId == null) {
      await this.safeRecord(message.taskId, 'task_resume_skipped', { reason: 'tarefa_nao_encontrada', blockReason: payload.blockReason ?? null })
      return
    }
    const reason = payload.blockReason ?? ''
    try {
      if (DEPLOY_BLOCK_REASONS.has(reason)) {
        const dispatched = await this.retryDeploy(databaseTaskId, message)
        await this.safeRecord(message.taskId, 'task_resumed_by_monitor', { blockReason: reason, action: 'deploy_requeued', dispatched })
        return
      }
      if (reason === 'analysis_failed') {
        await this.enqueueResumeAnalysis(message, databaseTaskId)
        await this.safeRecord(message.taskId, 'task_resumed_by_monitor', { blockReason: reason, action: 'analysis_resume_enqueued' })
        return
      }
      await this.safeRecord(message.taskId, 'task_resumed_by_monitor', { blockReason: reason || null, action: 'noop' })
    } catch (error) {
      // Não propaga para a fila: a retomada pode ser refeita manualmente ou
      // pela reconciliação de boot (deployConsumer.recoverPendingWork).
      await this.safeRecord(message.taskId, 'task_resume_failed', {
        blockReason: reason || null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Pedidos de deploy `failed` da tarefa voltam a `pending` e recebem
   * dispatch na mesma transação (fato + evento atômicos).
   */
  private async retryDeploy(databaseTaskId: number, source: QueueMessage): Promise<number> {
    const connection: PoolConnection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query<ResultSetHeader>(
        `UPDATE deploy_requests
            SET status='pending', last_error=NULL, started_at=NULL, finished_at=NULL, updated_at=NOW()
          WHERE tarefa_id=? AND status='failed'`,
        [databaseTaskId],
      )
      const [groups] = await connection.query<Array<RowDataPacket & { repo_path: string; base_branch: string; requested_commit: string }>>(
        `SELECT repo_path, base_branch, requested_commit
           FROM deploy_requests
          WHERE tarefa_id=? AND status='pending'
          GROUP BY repo_path, base_branch, requested_commit`,
        [databaseTaskId],
      )
      for (const group of groups) {
        const dispatch = createQueueMessage({
          type: 'DEPLOY_BATCH_DISPATCH_REQUESTED',
          taskId: String(databaseTaskId),
          executionId: `deploy-dispatch-monitor-${Date.now()}-${randomUUID()}`,
          correlationId: source.correlationId ?? source.messageId,
          causationId: source.messageId,
          payload: { repository: group.repo_path, baseBranch: group.base_branch, expectedCommit: group.requested_commit },
        })
        await insertOutboxMessage(connection, dispatch)
      }
      await connection.commit()
      return groups.length
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async enqueueResumeAnalysis(source: QueueMessage, databaseTaskId: number): Promise<void> {
    const resume = createQueueMessage({
      type: 'TASK_RESUME_REQUESTED',
      taskId: source.taskId,
      executionId: `monitor-resume-${databaseTaskId}-${Date.now()}`,
      correlationId: source.correlationId ?? source.messageId,
      causationId: source.messageId,
      payload: { resumedBy: 'monitor' },
    })
    await insertOutboxMessage(this.pool, resume)
  }

  private async resolveDatabaseTaskId(taskId: string): Promise<number | null> {
    const numeric = /^\d+$/.test(taskId)
    const [rows] = await this.pool.query<Array<RowDataPacket & { id: number }>>(
      `SELECT id FROM tarefas WHERE ${numeric ? 'external_id = ? OR CAST(id AS CHAR) = ?' : 'external_id = ?'} LIMIT 1`,
      numeric ? [taskId, taskId] : [taskId],
    )
    return rows[0]?.id != null ? Number(rows[0].id) : null
  }

  private async safeRecord(taskId: string, evento: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.events.record(taskId, evento, 'motor', payload)
    } catch {
      // Auditoria nunca derruba o fluxo principal.
    }
  }
}
