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
      // O bloqueio é emitido por membro, mas a unidade de reentrada é o lote.
      // Primeiro localizamos e bloqueamos todos os membros; só depois alteramos
      // qualquer pedido. Isso evita que o primeiro TASK_UNBLOCKED crie um lote
      // concorrente enquanto os demais membros ainda apontam para o lote falho.
      const [seedRows] = await connection.query<Array<RowDataPacket & {
        batch_id: string | null
        repo_path: string
        base_branch: string
        requested_commit: string
      }>>(
        `SELECT dr.batch_id,dr.repo_path,dr.base_branch,dr.requested_commit
           FROM deploy_requests dr
          WHERE dr.tarefa_id=? AND dr.status='failed'
          ORDER BY dr.id DESC LIMIT 1 FOR UPDATE`,
        [databaseTaskId],
      )
      const batchId = seedRows[0]?.batch_id ? String(seedRows[0].batch_id) : null
      let memberTaskIds = [databaseTaskId]
      if (batchId) {
        const [memberRows] = await connection.query<Array<RowDataPacket & { tarefa_id: number }>>(
          `SELECT dr.id,dr.tarefa_id,dr.repo_path,dr.base_branch,dr.requested_commit
             FROM deploy_requests dr
            WHERE dr.batch_id=?
            ORDER BY dr.id FOR UPDATE`,
          [batchId],
        )
        const ids = memberRows.map(row => Number(row.tarefa_id)).filter(Number.isInteger)
        if (ids.length > 0) memberTaskIds = ids
        // O lote falho deixa de ser reutilizável. Seus membros voltam a ser
        // pedidos novos; o registro do lote e last_error permanecem como
        // diagnóstico histórico. O UPDATE condicionado torna a operação
        // idempotente para redelivery e para desbloqueios de outros membros.
      }
      const [reset] = await connection.query<ResultSetHeader>(
        `UPDATE deploy_requests
            SET status='pending', batch_id=NULL, started_at=NULL, finished_at=NULL, updated_at=NOW()
          WHERE ${batchId ? 'batch_id=?' : 'tarefa_id=?'} AND status='failed'`,
        [batchId ?? databaseTaskId],
      )
      if (Number(reset.affectedRows ?? 0) === 0) {
        await connection.commit()
        return 0
      }
      if (batchId) {
        // Nenhum gate/dispatch órfão do lote pode reacender a execução antiga.
        // Eventos históricos e o diagnóstico do lote não são removidos.
        await connection.query(
          `UPDATE test_gate_jobs SET status='failed',finished_at=COALESCE(finished_at,NOW(3)),
                  updated_at=NOW(3),error_message=COALESCE(error_message,?)
             WHERE id=(SELECT gate_job_id FROM deploy_batches WHERE batch_id=? LIMIT 1)
               AND status IN ('pending','processing')`,
          ['Gate invalidado pela recuperação idempotente do lote', batchId],
        )
        await connection.query(
          `DELETE FROM motor_outbox
             WHERE status='pending'
               AND type IN ('DEPLOY_BATCH_DISPATCH_REQUESTED','DEPLOY_RECONCILIATION_REQUESTED')
               AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.batchId'))=?`,
          [batchId],
        )
        // Só o dono do lote pode liberar o lock; um desbloqueio atrasado não
        // pode liberar o lock de um deploy concorrente.
        await connection.query(
          `UPDATE motor_deploy_lock SET locked=FALSE,locked_at=NULL,locked_by=NULL,reason=NULL
             WHERE id=1 AND locked_by=?`,
          [batchId],
        )
      }
      const [groups] = await connection.query<Array<RowDataPacket & { repo_path: string; base_branch: string; requested_commit: string }>>(
        `SELECT repo_path, base_branch, requested_commit
           FROM deploy_requests
          WHERE tarefa_id IN (${memberTaskIds.map(() => '?').join(',')}) AND status='pending'
          GROUP BY repo_path, base_branch, requested_commit`,
        memberTaskIds,
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
        // A segunda entrega de TASK_UNBLOCKED encontra affectedRows=0 acima.
        // Ainda assim, o predicado protege contra boot/reconciliador concorrente.
        await connection.query(
          `INSERT INTO motor_outbox (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
           SELECT ?,?,?, ?,?,?,NOW(),?,?,'pending',0
             FROM DUAL
            WHERE NOT EXISTS (
              SELECT 1 FROM motor_outbox
               WHERE status='pending' AND type='DEPLOY_BATCH_DISPATCH_REQUESTED'
                 AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.repository'))=?
                 AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.baseBranch'))=?
                 AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.expectedCommit'))=?
            )`,
          [dispatch.messageId, dispatch.type, 'motor.commands', dispatch.taskId, dispatch.executionId,
            JSON.stringify(dispatch.payload), dispatch.correlationId ?? null, dispatch.causationId ?? null,
            group.repo_path, group.base_branch, group.requested_commit],
        )
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
      executionId: `analysis-monitor-resume-${databaseTaskId}-${Date.now()}`,
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
