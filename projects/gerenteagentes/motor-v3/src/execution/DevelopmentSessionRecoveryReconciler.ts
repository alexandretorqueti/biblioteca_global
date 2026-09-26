import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { AnalystConsole, AnalystSession } from '../analysis/ConsoleAnalystRunner.js'
import { createQueueMessage, type QueueMessage } from '../queue/QueueMessage.js'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import type { MySqlDevelopmentExecutionRepository } from './DevelopmentExecutionRepository.js'
import type { SubtaskExecutionConsumer } from './SubtaskExecutionConsumer.js'
import type { WorkerConsoleAdapter } from './WorkerConsoleAdapter.js'

interface RecoveryRow extends RowDataPacket {
  session_id: number
  tarefa_id: number
  task_external_id: string | null
  subtarefa_id: number
  session_key: string
  runtime_session_id: string | null
  agent_id: string
  model: string
  execution_id: string | null
  baseline_run_id: number | null
}

export interface DevelopmentSessionRecoveryConfig {
  intervalMs?: number
  staleMinutes?: number
  taskEvents?: TaskEventSink
}

/** Reconcilia sessões DEV persistidas que perderam o worker durante restart. */
export class DevelopmentSessionRecoveryReconciler {
  private readonly inFlight = new Set<number>()
  private readonly intervalMs: number
  private readonly staleMinutes: number
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly pool: Pool,
    private readonly repository: MySqlDevelopmentExecutionRepository,
    private readonly consumer: Pick<SubtaskExecutionConsumer, 'recoverCompletedSession'>,
    private readonly consoleApi: AnalystConsole,
    private readonly consoleAdapter: WorkerConsoleAdapter,
    private readonly config: DevelopmentSessionRecoveryConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 30_000
    this.staleMinutes = config.staleMinutes ?? 35
  }

  start(): void {
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async reconcile(): Promise<void> {
    try {
      const [rows] = await this.pool.query<RecoveryRow[]>(`
        SELECT mas.id AS session_id, s.tarefa_id, t.external_id AS task_external_id,
               mas.subtarefa_id, mas.session_key, mas.runtime_session_id,
               mas.agent_id, mas.model, ctx.last_run_id AS execution_id,
               (SELECT tr.id FROM test_runs tr
                 WHERE tr.tarefa_id = s.tarefa_id AND tr.subtarefa_id = s.id AND tr.phase = 'baseline'
                 ORDER BY tr.finished_at DESC, tr.id DESC LIMIT 1) AS baseline_run_id
          FROM motor_agent_sessions mas
          INNER JOIN subtarefas s ON s.id = mas.subtarefa_id
          INNER JOIN tarefas t ON t.id = s.tarefa_id
          LEFT JOIN tarefa_contextos_execucao ctx
            ON ctx.subtarefa_id = s.id AND ctx.sessao_chave = mas.session_key
           AND ctx.fase = 'development' AND ctx.estado != 'closed'
         WHERE mas.status = 'active'
           AND s.status = 'running'
         ORDER BY mas.subtarefa_id, mas.opened_at DESC, mas.id DESC
      `)
      const seen = new Set<number>()
      const recoveries: Promise<void>[] = []
      for (const row of rows) {
        if (seen.has(Number(row.subtarefa_id))) continue
        seen.add(Number(row.subtarefa_id))
        if (!row.runtime_session_id || !row.execution_id || this.inFlight.has(Number(row.session_id))) continue
        if (this.consoleAdapter.isLocallyOwned(String(row.runtime_session_id))) continue
        this.inFlight.add(Number(row.session_id))
        recoveries.push(this.recover(row)
          .catch(error => console.error(`[Motor v3] Falha ao recuperar sessão DEV ${row.session_id}:`, this.errorMessage(error)))
          .finally(() => this.inFlight.delete(Number(row.session_id))))
      }
      await Promise.all(recoveries)
      await this.reconcileRunningWithoutSession()
    } catch (error) {
      console.error('[Motor v3] Falha no ciclo de recuperação de sessões DEV:', this.errorMessage(error))
    }
  }

  /**
   * Rede de segurança para execuções antigas que caíram antes de persistir a
   * sessão (caso da tarefa 905). A janela é maior que o timeout normal do
   * worker para não disputar com uma preparação/baseline legítima.
   */
  private async reconcileRunningWithoutSession(): Promise<void> {
    const [rows] = await this.pool.query<Array<RowDataPacket & {
      tarefa_id: number; task_external_id: string | null; subtarefa_id: number
    }>>(
      `SELECT s.tarefa_id, t.external_id AS task_external_id, s.id AS subtarefa_id
         FROM subtarefas s
         INNER JOIN tarefas t ON t.id=s.tarefa_id
        WHERE s.status='running'
          AND s.updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
          AND NOT EXISTS (
            SELECT 1 FROM motor_agent_sessions mas
             WHERE mas.subtarefa_id=s.id AND mas.status='active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM motor_message_processing_state mps
             WHERE mps.task_id IN (t.external_id, CAST(t.id AS CHAR))
               AND mps.message_type='SUBTASK_EXECUTION_REQUESTED'
               AND mps.status='processing'
               AND mps.started_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
          )`,
      [this.staleMinutes, this.staleMinutes],
    )
    for (const row of rows) {
      const taskId = String(row.task_external_id ?? row.tarefa_id)
      const executionId = `orphan-dev-${row.subtarefa_id}`
      try {
        await this.repository.requeueInterruptedExecution(
          taskId, Number(row.subtarefa_id), executionId, 'running_without_persisted_session',
        )
        await this.record(taskId, 'development_orphan_requeued', {
          subtaskId: row.subtarefa_id, reason: 'running_without_persisted_session',
        })
      } catch (error) {
        console.error(`[Motor v3] Falha ao reenfileirar DEV órfão ${row.subtarefa_id}:`, this.errorMessage(error))
      }
    }
  }

  private async recover(row: RecoveryRow): Promise<void> {
    const taskId = String(row.task_external_id ?? row.tarefa_id)
    const session: AnalystSession = {
      sessionId: String(row.runtime_session_id),
      sessionKey: String(row.session_key),
      agentId: String(row.agent_id),
    }
    this.consoleAdapter.attachSession(session)
    let status: Awaited<ReturnType<AnalystConsole['getSessionStatus']>>
    try {
      status = await this.consoleApi.getSessionStatus(session)
    } catch (error) {
      // Indisponibilidade transitória do Console não invalida o checkpoint.
      if (!/\b404\b|not found|não encontrad/i.test(this.errorMessage(error))) throw error
      await this.requeue(row, taskId, 'development_session_missing')
      return
    }
    if (status.isFailed) {
      await this.requeue(row, taskId, `development_session_failed:${status.error ?? 'unknown'}`)
      return
    }
    if (!status.isComplete || !status.lastResponse) {
      await this.touch(row.session_id)
      return
    }

    const message: QueueMessage = createQueueMessage({
      type: 'SUBTASK_EXECUTION_REQUESTED',
      taskId,
      executionId: String(row.execution_id),
      payload: { subtaskId: Number(row.subtarefa_id), recoveredSession: true },
    })
    await this.record(taskId, 'development_session_recovery_completed', {
      sessionId: row.session_id,
      subtaskId: row.subtarefa_id,
      executionId: row.execution_id,
    })
    await this.consumer.recoverCompletedSession({
      message,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      model: String(row.model),
      response: status.lastResponse,
      ...(row.baseline_run_id ? { baselineRunId: Number(row.baseline_run_id) } : {}),
    })
    await this.close(row, 'completed', 'development_recovered')
  }

  private async requeue(row: RecoveryRow, taskId: string, reason: string): Promise<void> {
    await this.close(row, 'failed', reason.slice(0, 100))
    await this.repository.requeueInterruptedExecution(taskId, Number(row.subtarefa_id), String(row.execution_id), reason)
    await this.record(taskId, 'development_session_requeued', {
      sessionId: row.session_id, subtaskId: row.subtarefa_id, executionId: row.execution_id, reason,
    })
  }

  private async close(row: RecoveryRow, status: 'completed' | 'failed', reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE motor_agent_sessions SET status=?, close_reason=?, closed_at=NOW(), last_activity_at=NOW()
        WHERE id=? AND status='active'`,
      [status, reason, row.session_id],
    )
    await this.pool.query(
      `UPDATE tarefa_contextos_execucao SET estado='closed', closed_at=NOW(), updated_at=NOW()
        WHERE subtarefa_id=? AND sessao_chave=? AND estado!='closed'`,
      [row.subtarefa_id, row.session_key],
    )
  }

  private async touch(sessionId: number): Promise<void> {
    await this.pool.query('UPDATE motor_agent_sessions SET last_activity_at=NOW() WHERE id=? AND status=\'active\'', [sessionId])
  }

  private async record(taskId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.config.taskEvents?.record(taskId, event, 'motor', payload) }
    catch (error) { console.warn(`[Motor v3] Falha ao registrar ${event}:`, this.errorMessage(error)) }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
