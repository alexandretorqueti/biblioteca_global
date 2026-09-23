import type { Pool, RowDataPacket } from 'mysql2/promise'
import { parseAnalystReply, type AnalysisOutcome } from '../analysis/AnalystReply.js'
import type { AnalystConsole, AnalystSession, ConsoleAnalystRunner } from '../analysis/ConsoleAnalystRunner.js'
import type { TaskCoordinatorRepository, TaskSnapshot } from './TaskCoordinator.js'
import type { TaskEventSink } from './TaskEventRecorder.js'

interface RecoveryRow extends RowDataPacket {
  session_id: number; tarefa_id: number; task_external_id: string | null; session_key: string
  runtime_session_id: string | null; model: string; execution_order: number
  analysis_execution_id: string | null; analysis_attempt_id: string | null; model_attempt: number
  analysis_started_at: Date | string | null
}

export interface AnalysisSessionRecoveryConfig {
  publishTaskReady: (taskId: string, executionId: string, subtaskCount: number) => Promise<void>
  taskEvents?: TaskEventSink
  intervalMs?: number
}

/**
 * Reconcilia análises interrompidas preservando a sessão do analista.
 * Nunca cria uma nova análise: primeiro consome um resultado já concluído;
 * caso não exista, pede continuidade na mesma session_key.
 */
export class AnalysisSessionRecoveryReconciler {
  private readonly inFlight = new Set<number>()
  private timer: NodeJS.Timeout | null = null
  private readonly intervalMs: number

  constructor(
    private readonly pool: Pool,
    private readonly repository: TaskCoordinatorRepository,
    private readonly runner: ConsoleAnalystRunner,
    private readonly consoleApi: AnalystConsole,
    private readonly config: AnalysisSessionRecoveryConfig,
  ) { this.intervalMs = config.intervalMs ?? 300_000 }

  start(): void {
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  async reconcile(): Promise<void> {
    const [rows] = await this.pool.query<RecoveryRow[]>(`
      SELECT s.id AS session_id, s.tarefa_id, t.external_id AS task_external_id,
             s.session_key, s.runtime_session_id, s.model, s.execution_order,
             s.analysis_execution_id, s.analysis_attempt_id, s.model_attempt,
             f.analysis_started_at
        FROM analyst_task_sessions s
        INNER JOIN tarefas t ON t.id = s.tarefa_id
        LEFT JOIN task_runtime_facts f ON f.tarefa_id = s.tarefa_id
        LEFT JOIN motor_active_executions e
          ON e.execution_id = s.analysis_execution_id AND e.expires_at > NOW()
       WHERE s.status = 'active' AND e.execution_id IS NULL
       ORDER BY s.tarefa_id ASC, s.opened_at DESC, s.id DESC
    `)
    const seenTasks = new Set<number>()
    for (const row of rows) {
      // Só a sessão mais recente de cada tarefa pode ser retomada. As antigas
      // pertencem a tentativas substituídas pelo retry anterior.
      if (seenTasks.has(Number(row.tarefa_id))) { await this.supersede(row); continue }
      seenTasks.add(Number(row.tarefa_id))
      if (!row.analysis_execution_id || !row.runtime_session_id || this.inFlight.has(Number(row.session_id))) continue
      this.inFlight.add(Number(row.session_id))
      void this.recover(row).finally(() => this.inFlight.delete(Number(row.session_id)))
    }
  }

  private async recover(row: RecoveryRow): Promise<void> {
    const taskId = String(row.task_external_id ?? row.tarefa_id)
    const task = await this.repository.getTask(taskId)
    if (!task || task.terminal || task.paused || task.subtaskCount > 0) return
    const session: AnalystSession = { sessionId: String(row.runtime_session_id), sessionKey: String(row.session_key), agentId: task.agentId }
    const status = await this.consoleApi.getSessionStatus(session)
    if (status.isComplete && status.lastResponse) {
      try {
        await this.complete(row, task, parseAnalystReply(status.lastResponse))
        return
      } catch (error) {
        // A sessão terminou mas a resposta não é um plano válido; a correção
        // ocorre na própria sessão abaixo, com o contrato atual.
        console.warn(`[Motor v3] Resultado recuperado inválido da sessão ${row.session_id}:`, error instanceof Error ? error.message : String(error))
      }
    }
    if (status.isFailed) {
      await this.pool.query(`UPDATE analyst_task_sessions SET status='failed', close_reason='recovery_session_failed', closed_at=NOW(), last_activity_at=NOW() WHERE id=? AND status='active'`, [row.session_id])
      await this.record(taskId, 'analysis_recovery_failed', { sessionId: row.session_id, executionId: row.analysis_execution_id, error: status.error ?? 'Console informou falha' })
      return
    }
    await this.record(taskId, 'analysis_recovery_requested', { sessionId: row.session_id, executionId: row.analysis_execution_id })
    const outcome = await this.runner.resume(task, String(row.analysis_execution_id), session, {
      taskId, executionId: String(row.analysis_execution_id), analysisAttemptId: String(row.analysis_attempt_id ?? `recovery-${row.session_id}`), modelAttempt: Number(row.model_attempt || 1), model: String(row.model), phase: 'recovery',
    })
    await this.complete(row, task, outcome)
  }

  private async complete(row: RecoveryRow, task: TaskSnapshot, outcome: AnalysisOutcome): Promise<void> {
    const executionId = String(row.analysis_execution_id)
    await this.repository.persistAnalysis(task.taskId, executionId, outcome)
    await this.repository.releaseAnalysisClaim(task.taskId, executionId)
    await this.pool.query(`UPDATE analyst_task_sessions SET status='completed', close_reason='analysis_recovered', closed_at=NOW(), last_activity_at=NOW() WHERE id=? AND status='active'`, [row.session_id])
    if (outcome.kind === 'plan') {
      await this.record(task.taskId, 'analysis_recovered_completed', { sessionId: row.session_id, executionId, subtaskCount: outcome.subtasks.length })
      await this.config.publishTaskReady(task.taskId, executionId, outcome.subtasks.length)
    } else {
      await this.record(task.taskId, 'analysis_recovered_clarification', { sessionId: row.session_id, executionId, questionCount: outcome.questions.length })
    }
  }

  private async supersede(row: RecoveryRow): Promise<void> {
    await this.pool.query(`UPDATE analyst_task_sessions SET status='superseded', close_reason='superseded_by_newer_recovery_session', closed_at=NOW(), last_activity_at=NOW() WHERE id=? AND status='active'`, [row.session_id])
  }

  private async record(taskId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.config.taskEvents?.record(taskId, event, 'motor', payload) }
    catch (error) { console.warn(`[Motor v3] Falha ao registrar ${event}:`, error instanceof Error ? error.message : String(error)) }
  }
}
