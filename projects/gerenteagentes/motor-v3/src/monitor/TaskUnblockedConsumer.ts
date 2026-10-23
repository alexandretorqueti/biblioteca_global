import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from '../queue/index.js'
import { createQueueMessage, insertOutboxMessage } from '../queue/index.js'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import { TASK_UNBLOCKED_EVENT_TYPE, type TaskUnblockedPayload } from './TaskBlockedEvent.js'
import { SUBTASK_VERIFICATION_REQUESTED } from '../execution/SubtaskVerificationConsumer.js'

/** Motivos de bloqueio cuja retomada é refazer o deploy da tarefa. */
const DEPLOY_BLOCK_REASONS = new Set([
  'deploy_failed',
  'pre_deploy_gate_failed',
  'deploy_preparation_failed',
])
const SUBTASK_VERIFICATION_BLOCK_REASON = 'subtask_verification_failed'

/**
 * Motivos de falha terminal de subtarefa (tarefa 1043): `worker_exhausted`
 * marca a subtarefa como 'failed' (completeExecution) e `subtask_terminal_failure`
 * como 'blocked' (SubtaskTerminalFailureBlocker). Resolver o bloqueio precisa
 * reabrir exatamente a subtarefa afetada — sem isso, a tarefa fica inerte com
 * as subtarefas seguintes pendentes (incidente 1403/1404/1405).
 */
const SUBTASK_TERMINAL_BLOCK_REASONS = new Set([
  'worker_exhausted',
  'subtask_terminal_failure',
])

/**
 * Comando durável de retomada da programação. Literal local (mesmo padrão de
 * 'DEPLOY_REQUESTED'/'TASK_RESUME_REQUESTED' neste arquivo) para evitar ciclo
 * de import com src/execution.
 */
const TASK_READY_FOR_PROGRAMMING = 'TASK_READY_FOR_PROGRAMMING'

/** Resultado da retomada de bloqueio por falha terminal de subtarefa. */
type TerminalReopenOutcome =
  | { action: 'subtask_reopened_for_programming'; subtaskId: number; reopened: true }
  | { action: 'task_ready_for_programming_enqueued'; subtaskId: null; reopened: false }
  | { action: 'subtask_not_reopenable'; subtaskId: number | null; reopened: false }

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
 * - `subtask_verification_failed` → subtarefas bloqueadas voltam a
 *   `verifying` e recebem `SUBTASK_VERIFICATION_REQUESTED`;
 * - `worker_exhausted`/`subtask_terminal_failure` → a subtarefa `failed`/
 *   `blocked` do bloqueio volta a `pending` (resultado limpo) e a tarefa
 *   recebe `TASK_READY_FOR_PROGRAMMING` na mesma transação, para o
 *   `reserveNextSubtask` retomar exatamente da subtarefa reaberta;
 * - demais motivos → apenas auditoria (o fluxo normal já sabe retomar).
 *
 * Idempotente: redelivery não duplica dispatch (UPDATE ... WHERE status='failed'
 * não re-reseta pedidos já retomados; dispatch de pending é deduplicado pelo
 * claim de lote do DeployConsumer).
 *
 * Intervenções externas permanecem restritas à API oficial de resolução; não
 * há suporte a SQL direto para alterar bloqueios, subtarefas ou o outbox.
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
      if (reason === 'deploy_member_conflict') {
        const staleRemoved = await this.enqueueFreshDeployRequest(message, databaseTaskId)
        await this.safeRecord(message.taskId, 'task_resumed_by_monitor', { blockReason: reason, action: 'deploy_request_refreshed', staleRequestsRemoved: staleRemoved })
        return
      }
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
      if (reason === SUBTASK_VERIFICATION_BLOCK_REASON) {
        const requeued = await this.retrySubtaskVerification(message, databaseTaskId)
        await this.safeRecord(message.taskId, 'task_resumed_by_monitor', {
          blockReason: reason, action: 'subtask_verification_requeued', requeued,
        })
        return
      }
      if (SUBTASK_TERMINAL_BLOCK_REASONS.has(reason)) {
        const outcome = await this.reopenTerminalFailedSubtask(message, databaseTaskId, reason)
        await this.safeRecord(message.taskId, 'task_resumed_by_monitor', {
          blockReason: reason,
          action: outcome.action,
          subtaskId: outcome.subtaskId ?? null,
          reopened: outcome.reopened,
        })
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
   * Reabre somente subtarefas ainda bloqueadas pelo motivo de falha terminal
   * da verificação e publica o pedido na mesma transação do fato. O UPDATE
   * condicionado a `blocked` torna redelivery idempotente: uma subtarefa já
   * reaberta (ou já `verified`) não recebe outro pedido pendente.
   */
  private async retrySubtaskVerification(source: QueueMessage, databaseTaskId: number): Promise<number> {
    const connection: PoolConnection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const blockId = Number((source.payload as Partial<TaskUnblockedPayload>).blockId)
      const hasBlockId = Number.isInteger(blockId) && blockId > 0
      const [rows] = await connection.query<Array<RowDataPacket & { id: number; seq: number }>>(
        `SELECT s.id, s.seq
           FROM subtarefas s
           INNER JOIN bloqueios b ON b.subtarefa_id = s.id
          WHERE s.tarefa_id = ?
            AND s.status = 'blocked'
            AND b.block_reason = ?
            AND (${hasBlockId ? 'b.id = ?' : '1=1'})
          FOR UPDATE`,
        hasBlockId ? [databaseTaskId, SUBTASK_VERIFICATION_BLOCK_REASON, blockId] : [databaseTaskId, SUBTASK_VERIFICATION_BLOCK_REASON],
      )

      let requeued = 0
      for (const row of rows) {
        const [updated] = await connection.query<ResultSetHeader>(
          `UPDATE subtarefas SET status='verifying', resultado=NULL, updated_at=NOW()
             WHERE id=? AND status='blocked'`,
          [Number(row.id)],
        )
        if (Number(updated.affectedRows ?? 0) !== 1) continue

        const verification = createQueueMessage({
          type: SUBTASK_VERIFICATION_REQUESTED,
          taskId: source.taskId,
          executionId: `verification-resume-${Number(row.id)}-${Date.now()}-${randomUUID()}`,
          correlationId: source.correlationId ?? source.messageId,
          causationId: source.messageId,
          payload: { subtaskId: Number(row.id), seq: Number(row.seq), resumedBy: 'monitor' },
        })
        await connection.query(
          `INSERT INTO motor_outbox (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
           SELECT ?,?,?, ?,?,?,NOW(),?,?,'pending',0
             FROM DUAL
            WHERE NOT EXISTS (
              SELECT 1 FROM motor_outbox
               WHERE status='pending' AND type=?
                 AND task_id=?
                 AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.subtaskId'))=?
            )`,
          [verification.messageId, verification.type, 'motor.commands', verification.taskId, verification.executionId,
            JSON.stringify(verification.payload), verification.correlationId ?? null, verification.causationId ?? null,
            SUBTASK_VERIFICATION_REQUESTED, source.taskId, Number(row.id)],
        )
        requeued++
      }
      await connection.commit()
      return requeued
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /**
   * Retomada de falha terminal de subtarefa (tarefa 1043): reabre a subtarefa
   * do bloqueio (`failed` no `worker_exhausted`, `blocked` no
   * `subtask_terminal_failure`) para `pending` com resultado limpo e publica
   * `TASK_READY_FOR_PROGRAMMING` na mesma transação.
   *
   * Por que `TASK_READY_FOR_PROGRAMMING` e não `SUBTASK_EXECUTION_REQUESTED`
   * direto: o `SubtaskExecutionConsumer` só aceita subtarefa `running`
   * (`getExecutionContext(expectedStatus='running')`) — um pedido direto contra
   * subtarefa `pending` seria descartado como `subtask_not_running` e a
   * retomada nunca aconteceria. O `TASK_READY_FOR_PROGRAMMING` segue o padrão
   * canônico do `TaskExecutionReconciler` (reset de órfã → pending + READY):
   * o `reserveNextSubtask` faz o claim atômico `pending → running`, respeita
   * deploy lock, limites de capacidade, tarefa pausada/bloqueada e emite o
   * `SUBTASK_EXECUTION_REQUESTED` — recomeçando exatamente da subtarefa
   * reaberta (menor seq entre as pendentes elegíveis; ex.: 1403), enquanto
   * 1404/1405 seguem na sequência normal.
   *
   * Regras de segurança:
   * - Nunca reabre `verified`/`superseded` nem geração antiga (o fluxo de
   *   conclusão/verificação já faz o sequenciamento via
   *   `reserveNextSubtaskInTransaction`);
   * - Redelivery é idempotente: UPDATE condicionado a `status IN
   *   ('failed','blocked')` + subtarefa já `pending`/`running` não republica;
   * - Sem `subtaskId` utilizável (payload sem subtaskId e bloqueio sem
   *   subtarefa), cai no fallback durável: `TASK_READY_FOR_PROGRAMMING` sem
   *   subtaskId, com auditoria em `tarefa_eventos` via `task_resumed_by_monitor`.
   */
  private async reopenTerminalFailedSubtask(
    source: QueueMessage,
    databaseTaskId: number,
    reason: string,
  ): Promise<TerminalReopenOutcome> {
    const payload = (source.payload ?? {}) as Partial<TaskUnblockedPayload> & { subtaskId?: unknown }
    const connection: PoolConnection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()

      // 1. Resolver a subtarefa afetada: subtaskId do payload quando presente;
      //    senão via bloqueios (blockId do payload tem precedência; sem blockId,
      //    bloqueio mais recente do mesmo motivo).
      let subtaskId = Number(payload.subtaskId)
      if (!Number.isInteger(subtaskId) || subtaskId <= 0) {
        const blockId = Number(payload.blockId)
        const hasBlockId = Number.isInteger(blockId) && blockId > 0
        const [blockRows] = await connection.query<Array<RowDataPacket & { subtarefa_id: number | null }>>(
          `SELECT subtarefa_id FROM bloqueios
            WHERE tarefa_id = ? AND ${hasBlockId ? 'id = ?' : 'block_reason = ?'}
            ORDER BY id DESC LIMIT 1`,
          hasBlockId ? [databaseTaskId, blockId] : [databaseTaskId, reason],
        )
        subtaskId = Number(blockRows[0]?.subtarefa_id ?? NaN)
      }

      if (Number.isInteger(subtaskId) && subtaskId > 0) {
        const [rows] = await connection.query<Array<RowDataPacket & { id: number; seq: number; status: string; generation: number }>>(
          `SELECT s.id, s.seq, s.status, s.generation
             FROM subtarefas s
            WHERE s.id = ? AND s.tarefa_id = ?
            LIMIT 1 FOR UPDATE`,
          [subtaskId, databaseTaskId],
        )
        const row = rows[0]
        if (row) {
          const [genRows] = await connection.query<Array<RowDataPacket & { max_generation: number }>>(
            'SELECT MAX(generation) AS max_generation FROM subtarefas WHERE tarefa_id = ?',
            [databaseTaskId],
          )
          const status = String(row.status)
          const currentGeneration = Number(row.generation ?? 1) === Number(genRows[0]?.max_generation ?? 1)
          if (['failed', 'blocked'].includes(status) && currentGeneration) {
            const [updated] = await connection.query<ResultSetHeader>(
              `UPDATE subtarefas SET status='pending', resultado=NULL, updated_at=NOW()
                WHERE id=? AND status IN ('failed','blocked')`,
              [subtaskId],
            )
            if (Number(updated.affectedRows ?? 0) === 1) {
              await this.enqueueReadyForProgramming(connection, source, {
                reason, subtaskId, seq: Number(row.seq),
              })
              await connection.commit()
              return { action: 'subtask_reopened_for_programming', subtaskId, reopened: true }
            }
          }
          if (['pending', 'running', 'delivered', 'verifying', 'verified', 'superseded'].includes(status)) {
            // Redelivery (já reaberta/claimada) ou subtarefa finalizada: não
            // reabre nem publica — verified/superseded já tiveram a sequência
            // avançada pelo fluxo de conclusão.
            await connection.commit()
            return { action: 'subtask_not_reopenable', subtaskId, reopened: false }
          }
        }
        // Subtarefa inexistente ou de geração antiga: não há retomada direta
        // possível; segue para o fallback durável abaixo.
      }

      // 2. Fallback durável: sem subtaskId utilizável, o TASK_READY_FOR_PROGRAMMING
      //    faz o reserveNextSubtask escolher o próximo trabalho correto.
      await this.enqueueReadyForProgramming(connection, source, { reason })
      await connection.commit()
      return { action: 'task_ready_for_programming_enqueued', subtaskId: null, reopened: false }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /**
   * Publica `TASK_READY_FOR_PROGRAMMING` com guarda de deduplicação
   * (NOT EXISTS de mensagem pendente do mesmo tipo/tarefa) — redelivery ou
   * reconciliador concorrente não duplicam o comando.
   */
  private async enqueueReadyForProgramming(
    connection: PoolConnection,
    source: QueueMessage,
    extra: { reason: string; subtaskId?: number; seq?: number },
  ): Promise<void> {
    const ready = createQueueMessage({
      type: TASK_READY_FOR_PROGRAMMING,
      taskId: source.taskId,
      executionId: `unblock-resume-${extra.subtaskId ?? 'task'}-${Date.now()}-${randomUUID()}`,
      correlationId: source.correlationId ?? source.messageId,
      causationId: source.messageId,
      payload: {
        reason: `unblocked_${extra.reason}`,
        blockReason: extra.reason,
        resumedBy: 'monitor',
        ...(extra.subtaskId != null ? { subtaskId: extra.subtaskId, seq: extra.seq } : {}),
      },
    })
    await connection.query(
      `INSERT INTO motor_outbox (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
       SELECT ?,?,?, ?,?,?,NOW(),?,?,'pending',0
         FROM DUAL
        WHERE NOT EXISTS (
          SELECT 1 FROM motor_outbox
           WHERE status='pending' AND type=? AND task_id=?
        )`,
      [ready.messageId, ready.type, 'motor.commands', ready.taskId, ready.executionId,
        JSON.stringify(ready.payload), ready.correlationId ?? null, ready.causationId ?? null,
        TASK_READY_FOR_PROGRAMMING, source.taskId],
    )
  }

  /**
   * Conflito de membro invalida o SHA persistido no pedido anterior: a branch
   * de integração normalmente é rebaseada durante a resolução. Um novo
   * DEPLOY_REQUESTED faz o fluxo normal reler a branch de integração — mas
   * somente se não houver pedido persistido: `needsRequestPreparation` pula a
   * preparação quando já existe request (skip `deploy_request_already_persisted`),
   * e o `isolateConflictingMembers` devolve o request a `pending` PRESERVANDO o
   * `requested_commit` obsoleto. Sem remover esse pedido, o dispatch seguinte
   * recompõe o lote com o SHA antigo e o mesmo conflito ressurge em loop
   * (incidente task-p2-979: unblock 15:26 → compose 15:30 com commit obsoleto).
   *
   * Por isso, na mesma transação do novo DEPLOY_REQUESTED, removemos o pedido
   * `pending` sem lote da tarefa: ele não carrega valor durável (o prepare o
   * recria com o HEAD atual da integração, gate pre_deploy novo e geração
   * corrente). Pedidos `running`/com lote `pending`/`running` não são tocados —
   * há dispatch em andamento e o fluxo do lote segue responsável por eles.
   *
   * Pedidos `failed` cujo lote já terminou (ou nem existe) também são
   * removidos: quando TODOS os membros do lote conflitam, o batch falha e o
   * pedido permanece `failed` com `requested_commit` obsoleto. Sem removê-lo,
   * o novo DEPLOY_REQUESTED é ignorado no accept (`needsRequestPreparation`
   * encontra pedido existente → skip `deploy_request_already_persisted`) e a
   * retomada vira no-op — incidente task-p2-1011 (2026-10-15): o operador foi
   * obrigado a atualizar `requested_commit` via SQL direto e resolver por
   * `external-resolution`, contornando o fluxo canônico.
   */
  private async enqueueFreshDeployRequest(source: QueueMessage, databaseTaskId: number): Promise<number> {
    const request = createQueueMessage({
      type: 'DEPLOY_REQUESTED',
      taskId: source.taskId,
      executionId: `deploy-member-conflict-resume-${Date.now()}-${randomUUID()}`,
      correlationId: source.correlationId ?? source.messageId,
      causationId: source.messageId,
      payload: { reason: 'deploy_member_conflict_resolved', resumedBy: 'monitor' },
    })
    const connection: PoolConnection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [removed] = await connection.query<ResultSetHeader>(
        `DELETE dr FROM deploy_requests dr
          WHERE dr.tarefa_id=?
            AND (
              (dr.status='pending' AND dr.batch_id IS NULL)
              OR (dr.status='failed' AND (dr.batch_id IS NULL OR NOT EXISTS (
                    SELECT 1 FROM deploy_batches b
                     WHERE b.batch_id=dr.batch_id AND b.status IN ('pending','running'))))
            )`,
        [databaseTaskId],
      )
      // Dispatches órfãos com o SHA obsoleto não podem vencer a corrida contra
      // o novo prepare: sem pedido pending o claim não os aproveita, e a
      // remoção evita que um dispatch antigo reacenda após o re-prepare.
      await connection.query(
        `DELETE FROM motor_outbox
          WHERE status='pending'
            AND type='DEPLOY_BATCH_DISPATCH_REQUESTED'
            AND task_id=?`,
        [source.taskId],
      )
      await insertOutboxMessage(connection, request)
      await connection.commit()
      return Number(removed.affectedRows ?? 0)
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
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
