import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
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
  purpose: 'development' | 'baseline_fix'
  execution_id: string | null
  baseline_run_id: number | null
  subtask_status: string
  completion_nudge_count: number | string
  completion_nudged_at: Date | string | null
}

export interface DevelopmentSessionRecoveryConfig {
  intervalMs?: number
  staleMinutes?: number
  loopRepeatThreshold?: number
  maxCompletionNudges?: number
  completionNudgeCooldownMs?: number
  taskEvents?: TaskEventSink
}

/** Reconcilia sessões DEV persistidas que perderam o worker durante restart. */
export class DevelopmentSessionRecoveryReconciler {
  private readonly inFlight = new Set<number>()
  private readonly intervalMs: number
  private readonly staleMinutes: number
  private readonly loopRepeatThreshold: number
  private readonly maxCompletionNudges: number
  private readonly completionNudgeCooldownSeconds: number
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
    this.loopRepeatThreshold = config.loopRepeatThreshold ?? 5
    this.maxCompletionNudges = config.maxCompletionNudges ?? 2
    this.completionNudgeCooldownSeconds = Math.max(1, Math.round((config.completionNudgeCooldownMs ?? 300_000) / 1000))
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
               mas.agent_id, mas.model, mas.purpose, ctx.last_run_id AS execution_id, s.status AS subtask_status,
               mas.completion_nudge_count, mas.completion_nudged_at,
               (SELECT tr.id FROM test_runs tr
                 WHERE tr.tarefa_id = s.tarefa_id AND tr.subtarefa_id = s.id AND tr.phase = 'baseline'
                 ORDER BY tr.finished_at DESC, tr.id DESC LIMIT 1) AS baseline_run_id
          FROM motor_agent_sessions mas
          INNER JOIN subtarefas s ON s.id = mas.subtarefa_id
          INNER JOIN tarefas t ON t.id = s.tarefa_id
          LEFT JOIN tarefa_contextos_execucao ctx
            ON ctx.subtarefa_id = s.id AND ctx.sessao_chave = mas.session_key
           AND ctx.fase = mas.purpose AND ctx.estado != 'closed'
         WHERE mas.status = 'active'
           AND mas.purpose IN ('development', 'baseline_fix')
           AND (s.status IN ('pending', 'running')
             OR (s.status = 'failed' AND s.resultado LIKE '%Timeout global do worker%'))
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
             WHERE (mps.task_id = t.external_id COLLATE utf8mb4_unicode_ci
                 OR mps.task_id = CAST(t.id AS CHAR) COLLATE utf8mb4_unicode_ci)
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
    if (row.subtask_status === 'pending') {
      const claimed = await this.repository.claimPendingExecutionForRecovery(Number(row.subtarefa_id))
      if (!claimed) return
      row.subtask_status = 'running'
      await this.record(taskId, 'development_pending_session_reclaimed', {
        sessionId: row.session_id, subtaskId: row.subtarefa_id, executionId: row.execution_id,
      })
    }
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
      if (row.subtask_status === 'running') await this.requeue(row, taskId, 'development_session_missing')
      else await this.close(row, 'failed', 'legacy_development_session_missing')
      return
    }
    if (status.isFailed) {
      if (row.subtask_status === 'running') await this.requeue(row, taskId, `development_session_failed:${status.error ?? 'unknown'}`)
      else await this.close(row, 'failed', 'legacy_development_session_failed')
      return
    }
    if (row.subtask_status === 'failed') {
      const reopened = await this.repository.reopenTimedOutExecutionForRecovery(taskId, Number(row.subtarefa_id))
      if (!reopened) return
      await this.record(taskId, 'development_legacy_timeout_reopened', {
        sessionId: row.session_id, subtaskId: row.subtarefa_id, executionId: row.execution_id,
      })
    }
    if (!status.isComplete && (status.activity?.repeatedToolCalls ?? 0) >= this.loopRepeatThreshold) {
      await this.handleLoop(row, taskId, session, status.activity?.fingerprint, status.activity?.repeatedToolCalls ?? 0)
      return
    }
    if (!status.isComplete) {
      await this.touch(row.session_id)
      return
    }

    if (!status.lastResponse || !/::DONE::/i.test(status.lastResponse)) {
      await this.requestCompletionProtocol(row, taskId, session, status.lastResponse ? 'missing_done_marker' : 'missing_final_response')
      return
    }

    const message: QueueMessage = createQueueMessage({
      type: 'SUBTASK_EXECUTION_REQUESTED',
      taskId,
      executionId: String(row.execution_id),
      payload: { subtaskId: Number(row.subtarefa_id), recoveredSession: true },
    })
    if (row.purpose === 'baseline_fix') {
      const baselineConsumer = this.consumer as typeof this.consumer & { recoverBaselineFixSession?: (input: { message: QueueMessage; response: string }) => Promise<void> }
      if (!baselineConsumer.recoverBaselineFixSession) throw new Error('Consumidor não suporta recuperação baseline_fix')
      await this.record(taskId, 'baseline_fix_session_recovery_completed', {
        sessionId: row.session_id, subtaskId: row.subtarefa_id, executionId: row.execution_id,
      })
      await baselineConsumer.recoverBaselineFixSession({ message, response: status.lastResponse })
      await this.close(row, 'completed', 'baseline_fix_recovered')
      return
    }
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

  /**
   * Uma sessão que parou sem resposta final não perdeu seu contexto nem seu
   * worktree. Reativa exatamente a mesma conversa e limita os lembretes
   * persistidos para que reinícios concorrentes não criem um loop infinito.
   */
  private async requestCompletionProtocol(
    row: RecoveryRow,
    taskId: string,
    session: AnalystSession,
    reason: 'missing_done_marker' | 'missing_final_response',
  ): Promise<void> {
    if (Number(row.completion_nudge_count ?? 0) >= this.maxCompletionNudges) {
      const message = `Sessão DEV encerrada ${this.maxCompletionNudges} vez(es) sem ::DONE:: (${reason}); intervenção humana necessária.`
      await this.repository.blockIncompleteDevelopmentSession(taskId, Number(row.subtarefa_id), String(row.execution_id), message)
      await this.close(row, 'failed', 'development_completion_protocol_exhausted')
      await this.record(taskId, 'development_completion_protocol_exhausted', {
        sessionId: row.session_id, subtaskId: row.subtarefa_id, reason, attempts: Number(row.completion_nudge_count),
      })
      return
    }
    const [claim] = await this.pool.query<ResultSetHeader>(
      `UPDATE motor_agent_sessions
          SET completion_nudge_count=completion_nudge_count+1,
              completion_nudged_at=NOW(), last_activity_at=NOW()
        WHERE id=? AND status='active'
          AND completion_nudge_count < ?
          AND (completion_nudged_at IS NULL OR completion_nudged_at <= DATE_SUB(NOW(), INTERVAL ? SECOND))`,
      [row.session_id, this.maxCompletionNudges, this.completionNudgeCooldownSeconds],
    )
    if (claim.affectedRows !== 1) {
      await this.touch(row.session_id)
      return
    }
    try {
      await this.consoleAdapter.sendMessage({
        sessionId: session.sessionId,
        message: [
          'A execução anterior foi encerrada sem o protocolo de conclusão.',
          'Revise o trabalho já realizado neste mesmo worktree, conclua as validações necessárias e responda com um resumo final.',
          'Inclua obrigatoriamente o marcador ::DONE:: na resposta final.',
        ].join('\n'),
      })
      await this.record(taskId, 'development_completion_protocol_requested', {
        sessionId: row.session_id, subtaskId: row.subtarefa_id, reason,
        attempt: Number(row.completion_nudge_count) + 1,
      })
    } catch (error) {
      // A reserva evita duplicidade; em falha de transporte devolvemos a
      // tentativa para que o próximo ciclo possa tentar a mesma sessão.
      await this.pool.query(
        `UPDATE motor_agent_sessions
            SET completion_nudge_count=GREATEST(completion_nudge_count-1, 0), completion_nudged_at=NULL
          WHERE id=? AND status='active'`,
        [row.session_id],
      )
      throw error
    }
  }

  private async handleLoop(row: RecoveryRow, taskId: string, session: AnalystSession, fingerprint: string | undefined, repetitions: number): Promise<void> {
    if (!this.consoleApi.abortSession) {
      await this.record(taskId, 'development_session_loop_suspected', {
        sessionId: row.session_id, subtaskId: row.subtarefa_id, fingerprint, repetitions, action: 'attention_only',
      })
      await this.touch(row.session_id)
      return
    }
    const aborted = await this.consoleApi.abortSession(session)
    if (!aborted.aborted) {
      await this.record(taskId, 'development_session_loop_suspected', {
        sessionId: row.session_id, subtaskId: row.subtarefa_id, fingerprint, repetitions,
        action: 'abort_failed', error: aborted.error,
      })
      await this.touch(row.session_id)
      return
    }
    const reason = `development_session_loop_detected:${fingerprint ?? 'unknown'}:repetitions=${repetitions}`.slice(0, 100)
    await this.requeue(row, taskId, reason)
    await this.record(taskId, 'development_session_loop_requeued', {
      sessionId: row.session_id, subtaskId: row.subtarefa_id, fingerprint, repetitions,
    })
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
