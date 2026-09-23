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
    // `reconcile` já contém uma barreira de erro. A chamada explícita evita
    // que uma rejeição futura introduzida neste timer se transforme em uma
    // unhandled rejection e derrube o processo Node.
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  async reconcile(): Promise<void> {
    try {
      await this.reconcileOnce()
    } catch (error) {
      // Falha de leitura/escrita do reconciliador é operacional; o próximo
      // intervalo deve poder tentar novamente sem parar o Motor.
      console.error('[Motor v3] Falha no ciclo de recuperação de sessões de análise:', this.errorMessage(error))
    }
  }

  private async reconcileOnce(): Promise<void> {
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
       -- A sessão só pode ser retomada quando ainda detém o claim da tarefa.
       -- Uma tentativa posterior pode ter falhado, liberado/substituído o claim
       -- e tornado esta sessão histórica; nesse caso persistir seu resultado
       -- seria incorreto e violaria o fencing da análise.
       WHERE s.status = 'active'
         AND f.analysis_started_at IS NOT NULL
         AND f.analysis_execution_id = s.analysis_execution_id
         AND e.execution_id IS NULL
       ORDER BY s.tarefa_id ASC, s.opened_at DESC, s.id DESC
    `)
    const seenTasks = new Set<number>()
    for (const row of rows) {
      // Só a sessão mais recente de cada tarefa pode ser retomada. As antigas
      // pertencem a tentativas substituídas pelo retry anterior.
      if (seenTasks.has(Number(row.tarefa_id))) {
        try {
          await this.supersede(row)
        } catch (error) {
          // Uma sessão histórica não pode impedir a recuperação das demais.
          console.error(`[Motor v3] Falha ao superar sessão histórica ${row.session_id}:`, this.errorMessage(error))
        }
        continue
      }
      seenTasks.add(Number(row.tarefa_id))
      if (!row.analysis_execution_id || !row.runtime_session_id || this.inFlight.has(Number(row.session_id))) continue
      this.inFlight.add(Number(row.session_id))
      void this.recover(row)
        .catch(error => this.failRecovery(row, error))
        .catch(error => {
          // `failRecovery` é deliberadamente defensivo, mas esta última
          // barreira protege o processo caso seu contrato mude no futuro.
          console.error(`[Motor v3] Falha ao tratar erro da recuperação da sessão ${row.session_id}:`, this.errorMessage(error))
        })
        .finally(() => this.inFlight.delete(Number(row.session_id)))
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
      await this.failRecovery(row, new Error(status.error ?? 'Console informou falha'), 'recovery_session_failed')
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

  /**
   * Fecha somente a sessão que falhou e libera o claim com fencing pelo
   * executionId. Não reenfileira a tarefa: ela fica disponível para uma nova
   * ação explícita do usuário, nunca para retry automático do reconciliador.
   */
  private async failRecovery(row: RecoveryRow, error: unknown, closeReason = 'analysis_recovery_failed'): Promise<void> {
    const taskId = String(row.task_external_id ?? row.tarefa_id)
    const message = this.errorMessage(error)
    console.error(`[Motor v3] Recuperação da sessão ${row.session_id} falhou para task=${taskId}:`, message)

    try {
      await this.pool.query(
        `UPDATE analyst_task_sessions
            SET status='failed', close_reason=?, closed_at=NOW(), last_activity_at=NOW()
          WHERE id=? AND status='active'`,
        [closeReason, row.session_id],
      )
    } catch (closeError) {
      console.error(`[Motor v3] Falha ao fechar sessão de recuperação ${row.session_id}:`, this.errorMessage(closeError))
    }

    if (row.analysis_execution_id) {
      try {
        // O UPDATE do repositório exige o mesmo executionId; portanto uma
        // tentativa mais nova jamais perde seu claim por causa desta falha.
        await this.repository.releaseAnalysisClaim(taskId, String(row.analysis_execution_id))
      } catch (releaseError) {
        console.error(`[Motor v3] Falha ao liberar claim da recuperação ${row.session_id}:`, this.errorMessage(releaseError))
      }
    }

    await this.record(taskId, 'analysis_recovery_failed', {
      sessionId: row.session_id,
      executionId: row.analysis_execution_id,
      closeReason,
      error: message.slice(0, 1800),
    })
  }

  private async record(taskId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    try { await this.config.taskEvents?.record(taskId, event, 'motor', payload) }
    catch (error) { console.warn(`[Motor v3] Falha ao registrar ${event}:`, error instanceof Error ? error.message : String(error)) }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
