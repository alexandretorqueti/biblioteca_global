import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from '../queue/index.js'
import { insertOutboxMessage, createQueueMessage } from '../queue/index.js'
import type { WorkerLauncher } from '../worker-launcher/WorkerLauncher.js'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import type { ConsoleHumanNotifier, MonitorHumanNotifier } from './HumanNotifier.js'
import { PostDeployPromptResolver } from './PostDeployPromptResolver.js'
import { parsePostDeployVerdict, type PostDeployVerdict, type PostDeployFinding } from './PostDeployVerdictParser.js'
import type { OperationLogger, OperationOutcome, OperationPhase } from '../commands/index.js'

interface BatchTaskContext extends RowDataPacket {
  database_task_id: number
  task_id: string
  titulo: string
  descricao: string
  projeto_id: number
  project_slug: string
  repo_path: string
  criterios_aceite: string | null
}

interface SubtaskRow extends RowDataPacket {
  id: number
  titulo: string
  completion_kind: string | null
  status: string
}

interface CommitRow extends RowDataPacket {
  commit_sha: string
  commit_message: string
  files_changed: number | null
  insertions: number | null
  deletions: number | null
}

interface TestRunRow extends RowDataPacket {
  id: number
  phase: string
  status: string
  passed_count: number | null
  failed_count: number | null
  duration_ms: number | null
}

interface VerificationState extends RowDataPacket {
  id: number
  status: string
  verdict_json: string | null
  retry_count: number
  created_at: Date
  updated_at: Date
}

interface CorrectionCount extends RowDataPacket {
  correction_count: number
}

/**
 * PostDeployVerifier — verificação semântica pós-deploy (tarefa 971).
 *
 * Acionado por `DEPLOY_BATCH_SUCCEEDED`, executa verificação assíncrona
 * idempotente por batch_id. Uma sessão única do Monitor por lote, com
 * veredito por tarefa. Cria tarefas corretivas governadas (máx 2 por
 * tarefa-origem) e notifica o humano em caso de incongruência.
 *
 * Contrato:
 * - Nunca bloqueia o pipeline (falha = log error + segue)
 * - Idempotente por batch_id (reprocessamento não duplica)
 * - Evidência empírica somente leitura
 * - Anti-loop: máx 2 correções por tarefa-origem
 * - Flag independente: motor.postdeploy_verification.active
 */
export class PostDeployVerifier {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly pool: Pool,
    private readonly worker: Pick<WorkerLauncher, 'executeTask'>,
    private readonly prompts: PostDeployPromptResolver,
    private readonly events: TaskEventSink,
    private readonly notifier: MonitorHumanNotifier,
    private readonly logger?: OperationLogger,
    private readonly timeoutMs = Number(process.env.MOTOR_POSTDEPLOY_TIMEOUT_MS || 900_000), // 15 min
    private readonly maxRetries = Number(process.env.MOTOR_POSTDEPLOY_MAX_RETRIES || 1),
    private readonly maxCorrectionsPerTask = Number(process.env.MOTOR_POSTDEPLOY_MAX_CORRECTIONS || 2),
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== 'DEPLOY_BATCH_SUCCEEDED') return
    const batchId = String(message.payload?.batchId ?? '')
    if (!batchId) {
      await this.logError('postdeploy_missing_batch_id', message)
      return
    }

    // Verifica flag independente
    if (!await this.isActive()) {
      await this.logOperation(batchId, 'decision', 'skipped', message, { reasonCode: 'postdeploy_disabled' })
      return
    }

    // Idempotência: verifica se já existe verificação para este batch
    const existing = await this.findVerification(batchId)
    if (existing) {
      await this.logOperation(batchId, 'decision', 'skipped', message, { 
        reasonCode: 'postdeploy_already_verified',
        result: { verificationId: existing.id, status: existing.status },
      })
      return
    }

    // Anti-concorrência: instância única (mesma premissa de activeWorkers)
    if (this.inFlight.has(batchId)) {
      await this.logOperation(batchId, 'decision', 'skipped', message, { reasonCode: 'postdeploy_in_flight' })
      return
    }

    this.inFlight.add(batchId)
    const operationId = randomUUID()
    try {
      await this.logOperation(batchId, 'received', 'executed', message, { operationId })
      await this.runVerification(batchId, message, operationId)
    } catch (error) {
      // Falha do verificador NUNCA bloqueia o pipeline
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[PostDeployVerifier] Falha na verificação do batch ${batchId}:`, detail)
      await this.logOperation(batchId, 'failed', 'failed', message, { 
        operationId,
        reasonCode: 'postdeploy_verification_failed',
        result: { error: detail },
      })
      await this.persistVerification(batchId, 'failed', null, 0)
    } finally {
      this.inFlight.delete(batchId)
    }
  }

  private async runVerification(batchId: string, message: QueueMessage, operationId: string): Promise<void> {
    // Carrega contexto do batch (todas as tarefas)
    const tasks = await this.loadBatchTasks(batchId)
    if (tasks.length === 0) {
      await this.logOperation(batchId, 'decision', 'skipped', message, { reasonCode: 'postdeploy_no_tasks' })
      return
    }

    // Carrega subtarefas, commits e test_runs para cada tarefa
    const context = await this.buildContext(batchId, tasks)

    // Resolve prompt gerenciado
    const prompt = await this.prompts.resolve(batchId, {
      batchId,
      tasks: context.tasks.map(t => ({
        taskId: t.task_id,
        title: t.titulo,
        description: t.descricao,
        criteria: t.criterios_aceite ?? '—',
        subtasks: context.subtasks.get(t.database_task_id) ?? [],
      })),
      commits: context.commits,
      testRuns: context.testRuns,
      deployDiagnostics: context.diagnostics,
    })

    // Registra execução ativa do monitor
    const monitorExecutionId = `postdeploy-${batchId}-${Date.now()}`
    await this.registerMonitorExecution(monitorExecutionId, tasks[0]!.database_task_id)

    try {
      // Carrega cadeia MONITOR do projeto
      const models = await this.monitorModels(tasks[0]!.project_slug)
      if (models.length === 0) {
        await this.logOperation(batchId, 'decision', 'skipped', message, { reasonCode: 'postdeploy_no_monitor_models' })
        return
      }

      // Executa missão com a cadeia MONITOR
      const execution = {
        taskId: tasks[0]!.task_id,
        databaseTaskId: tasks[0]!.database_task_id,
        projectId: tasks[0]!.projeto_id,
        sessionKind: 'monitor' as const,
        executionId: message.executionId,
        generation: 1,
        projectSlug: tasks[0]!.project_slug,
        repoPath: tasks[0]!.repo_path,
        worktreePath: '', // Verificação pós-deploy não precisa de worktree
        branchName: '',
        baseCommitSha: '',
        agentId: 'monitor-pos-deploy',
        db: null,
        consoleApi: null,
        logger: console,
      }

      const result = await this.worker.executeTask(
        execution,
        prompt.text,
        models,
        undefined,
        undefined,
        true, // allowNoChanges
      )

      await this.safeRecord(batchId, 'postdeploy_verification_finished', {
        success: result.success,
        attempts: result.attempts,
        model: result.model ?? null,
        error: result.error ?? null,
      })

      // Parse do veredito
      const verdict = parsePostDeployVerdict(result.response ?? '')

      // Persiste verificação
      await this.persistVerification(batchId, this.mapStatus(verdict.status), JSON.stringify(verdict), 0)

      // Aplica veredito
      await this.applyVerdict(batchId, verdict, tasks, message, operationId)

      await this.logOperation(batchId, 'completed', 'succeeded', message, {
        operationId,
        result: { 
          verdictStatus: verdict.status,
          taskCount: tasks.length,
          findingCount: verdict.findings.length,
        },
      })
    } finally {
      await this.unregisterMonitorExecution(monitorExecutionId)
    }
  }

  private async applyVerdict(
    batchId: string,
    verdict: PostDeployVerdict,
    tasks: BatchTaskContext[],
    message: QueueMessage,
    operationId: string,
  ): Promise<void> {
    if (verdict.status === 'CONSISTENTE') {
      // Apenas registra o resultado
      await this.safeRecord(batchId, 'postdeploy_consistente', {
        findingCount: verdict.findings.length,
      })
      return
    }

    if (verdict.status === 'INCONCLUSIVO') {
      // Reagenda uma vez, depois notifica humano
      const verification = await this.findVerification(batchId)
      if (verification && verification.retry_count < this.maxRetries) {
        await this.persistVerification(batchId, 'pending', JSON.stringify(verdict), verification.retry_count + 1)
        await this.safeRecord(batchId, 'postdeploy_inconclusivo_rescheduled', {
          retryCount: verification.retry_count + 1,
        })
        // Enqueue retry
        const retryMessage = createQueueMessage({
          type: 'DEPLOY_BATCH_SUCCEEDED',
          taskId: message.taskId,
          executionId: `${message.executionId}-retry-${verification.retry_count + 1}`,
          correlationId: message.correlationId ?? message.messageId,
          causationId: message.messageId,
          payload: { batchId, retry: true },
        })
        await insertOutboxMessage(this.pool, retryMessage)
      } else {
        // Notifica humano
        await this.notifier.notify({
          taskId: tasks[0]!.task_id,
          blockReason: 'postdeploy_inconclusivo',
          summary: `Verificação pós-deploy inconclusiva após ${this.maxRetries} tentativas. Batch ${batchId}.`,
        })
        await this.safeRecord(batchId, 'postdeploy_inconclusivo_notified', {})
      }
      return
    }

    // INCONGRUENTE: cria tarefas corretivas (com anti-loop)
    for (const finding of verdict.findings) {
      const task = tasks.find(t => t.task_id === finding.taskId)
      if (!task) continue

      // Anti-loop: verifica contagem de correções para esta tarefa
      const count = await this.countCorrections(task.task_id)
      if (count >= this.maxCorrectionsPerTask) {
        // Notifica humano com histórico
        await this.notifier.notify({
          taskId: task.task_id,
          blockReason: 'postdeploy_anti_loop',
          summary: `Máximo de ${this.maxCorrectionsPerTask} correções atingido para tarefa ${task.task_id}. Finding: ${finding.description}`,
        })
        await this.safeRecord(batchId, 'postdeploy_anti_loop_triggered', {
          taskId: task.task_id,
          correctionCount: count,
          finding: finding.description,
        })
        continue
      }

      // Cria tarefa de correção (pausada)
      const correctionTaskId = await this.createCorrectionTask(
        task,
        finding,
        batchId,
        verdict,
      )

      if (correctionTaskId) {
        await this.safeRecord(batchId, 'postdeploy_correction_task_created', {
          originTaskId: task.task_id,
          correctionTaskId,
          severity: finding.severity,
          finding: finding.description,
        })

        // Notifica humano (severity baixa pode só notificar)
        if (finding.severity !== 'low') {
          await this.notifier.notify({
            taskId: task.task_id,
            blockReason: 'postdeploy_incongruente',
            summary: `Tarefa corretiva ${correctionTaskId} criada para ${task.task_id}: ${finding.description}`,
          })
        }
      }
    }
  }

  private async createCorrectionTask(
    originTask: BatchTaskContext,
    finding: PostDeployFinding,
    batchId: string,
    verdict: PostDeployVerdict,
  ): Promise<string | null> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()

      // External_id canônico
      const externalId = `postdeploy-${batchId}-${originTask.task_id}-${Date.now()}`

      // Insere tarefa pausada
      const [result] = await connection.query<ResultSetHeader>(
        `INSERT INTO tarefas
           (external_id, projeto_id, titulo, descricao, tipo, status, paused_at, created_at, updated_at)
         VALUES
           (?, ?, ?, ?, 'desenvolvimento', 'planned', NOW(), NOW(), NOW())`,
        [
          externalId,
          originTask.projeto_id,
          `Correção pós-deploy: ${finding.description.slice(0, 200)}`,
          this.buildCorrectionDescription(originTask, finding, verdict, batchId),
        ],
      )

      const databaseTaskId = result.insertId

      // Evento created com ator monitor-pos-deploy
      const createdEvent = createQueueMessage({
        type: 'TASK_CREATED',
        taskId: externalId,
        executionId: `postdeploy-${batchId}`,
        correlationId: undefined,
        causationId: undefined,
        payload: {
          databaseTaskId,
          originTaskId: originTask.task_id,
          actor: 'monitor-pos-deploy',
          batchId,
          findingSeverity: finding.severity,
        },
      })
      await insertOutboxMessage(connection, createdEvent)

      // Evento TASK_RESUME_REQUESTED para retomar a tarefa
      const resumeEvent = createQueueMessage({
        type: 'TASK_RESUME_REQUESTED',
        taskId: externalId,
        executionId: `postdeploy-resume-${batchId}`,
        correlationId: undefined,
        causationId: createdEvent.messageId,
        payload: {
          databaseTaskId,
          resumedBy: 'monitor-pos-deploy',
        },
      })
      await insertOutboxMessage(connection, resumeEvent)

      await connection.commit()
      return externalId
    } catch (error) {
      await connection.rollback()
      console.error(`[PostDeployVerifier] Falha ao criar tarefa corretiva:`, error)
      return null
    } finally {
      connection.release()
    }
  }

  private buildCorrectionDescription(
    originTask: BatchTaskContext,
    finding: PostDeployFinding,
    verdict: PostDeployVerdict,
    batchId: string,
  ): string {
    return [
      `## Tarefa corretiva criada pelo Monitor pós-deploy`,
      '',
      `**Tarefa origem:** ${originTask.task_id} (${originTask.titulo})`,
      `**Batch:** ${batchId}`,
      `**Severidade:** ${finding.severity}`,
      '',
      `### Finding`,
      finding.description,
      '',
      `### Evidência`,
      finding.evidence,
      '',
      `### Veredito completo`,
      verdict.raw.slice(0, 2000),
    ].join('\n')
  }

  private async countCorrections(originTaskId: string): Promise<number> {
    const [rows] = await this.pool.query<CorrectionCount[]>(
      `SELECT COUNT(*) AS correction_count
         FROM tarefas
        WHERE descricao LIKE ? AND tipo = 'desenvolvimento'`,
      [`%Tarefa origem: ${originTaskId}%`],
    )
    return rows[0]?.correction_count ?? 0
  }

  private async persistVerification(
    batchId: string,
    status: string,
    verdictJson: string | null,
    retryCount: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO motor_postdeploy_verifications
           (batch_id, status, verdict_json, retry_count, created_at, updated_at)
         VALUES
           (?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           verdict_json = VALUES(verdict_json),
           retry_count = VALUES(retry_count),
           updated_at = NOW()`,
        [batchId, status, verdictJson, retryCount],
      )
    } catch (error) {
      console.error(`[PostDeployVerifier] Falha ao persistir verificação:`, error)
    }
  }

  private async findVerification(batchId: string): Promise<VerificationState | null> {
    const [rows] = await this.pool.query<VerificationState[]>(
      `SELECT id, status, verdict_json, retry_count, created_at, updated_at
         FROM motor_postdeploy_verifications
        WHERE batch_id = ?
        LIMIT 1`,
      [batchId],
    )
    return rows[0] ?? null
  }

  private async loadBatchTasks(batchId: string): Promise<BatchTaskContext[]> {
    const [rows] = await this.pool.query<BatchTaskContext[]>(
      `SELECT t.id AS database_task_id,
              COALESCE(NULLIF(t.external_id,''), CAST(t.id AS CHAR)) AS task_id,
              t.titulo,
              t.descricao,
              t.projeto_id,
              pc.slug AS project_slug,
              pmc.repo_path,
              t.criterios_aceite
         FROM deploy_requests dr
         JOIN tarefas t ON t.id = dr.tarefa_id
         JOIN projetos_captados pc ON pc.id = t.projeto_id
         JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id
        WHERE dr.batch_id = ?`,
      [batchId],
    )
    return rows
  }

  private async buildContext(batchId: string, tasks: BatchTaskContext[]) {
    const subtasks = new Map<number, SubtaskRow[]>()
    const commits: CommitRow[] = []
    const testRuns: TestRunRow[] = []

    for (const task of tasks) {
      const [subtaskRows] = await this.pool.query<SubtaskRow[]>(
        `SELECT id, titulo, completion_kind, status
           FROM subtarefas
          WHERE tarefa_id = ?
          ORDER BY id`,
        [task.database_task_id],
      )
      subtasks.set(task.database_task_id, subtaskRows)

      const [commitRows] = await this.pool.query<CommitRow[]>(
        `SELECT commit_sha, commit_message, files_changed, insertions, deletions
           FROM motor_subtask_commits
          WHERE subtarefa_id IN (SELECT id FROM subtarefas WHERE tarefa_id = ?)
          ORDER BY committed_at DESC
          LIMIT 20`,
        [task.database_task_id],
      )
      commits.push(...commitRows)

      const [testRunRows] = await this.pool.query<TestRunRow[]>(
        `SELECT id, phase, status, passed_count, failed_count, duration_ms
           FROM test_runs
          WHERE tarefa_id = ?
          ORDER BY id DESC
          LIMIT 10`,
        [task.database_task_id],
      )
      testRuns.push(...testRunRows)
    }

    // Diagnóstico do deploy (do deploy_batches)
    const [batchRows] = await this.pool.query<Array<RowDataPacket & { last_error: string | null; started_at: Date; finished_at: Date }>>(
      `SELECT last_error, started_at, finished_at FROM deploy_batches WHERE batch_id = ? LIMIT 1`,
      [batchId],
    )
    const diagnostics = batchRows[0] ?? { last_error: null, started_at: null, finished_at: null }

    return { tasks, subtasks, commits, testRuns, diagnostics }
  }

  private async monitorModels(projectSlug: string): Promise<string[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { model: string }>>(
      `SELECT model FROM project_model_selection WHERE project_slug=? AND tipo='MONITOR' AND enabled=1 ORDER BY ordem`,
      [projectSlug],
    )
    return rows.map(row => String(row.model)).filter(Boolean)
  }

  private async registerMonitorExecution(executionId: string, databaseTaskId: number): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO motor_active_executions (execution_id, tarefa_id, subtarefa_id, phase, started_at, heartbeat_at, expires_at)
         VALUES (?, ?, NULL, 'postdeploy_monitor', NOW(), NOW(), DATE_ADD(NOW(), INTERVAL 20 MINUTE))`,
        [executionId, databaseTaskId],
      )
    } catch (error) {
      console.warn('[PostDeployVerifier] Falha ao registrar execução:', error)
    }
  }

  private async unregisterMonitorExecution(executionId: string): Promise<void> {
    try {
      await this.pool.query(
        'DELETE FROM motor_active_executions WHERE execution_id = ?',
        [executionId],
      )
    } catch (error) {
      console.warn('[PostDeployVerifier] Falha ao remover registro:', error)
    }
  }

  private async isActive(): Promise<boolean> {
    try {
      const [rows] = await this.pool.query<Array<RowDataPacket & { valor: boolean | number | string | null }>>(
        `SELECT valor FROM motor_configuracoes WHERE chave = 'motor.postdeploy_verification.active' LIMIT 1`,
      )
      const value = rows[0]?.valor
      if (value == null) return true // Default true
      if (typeof value === 'boolean') return value
      if (typeof value === 'number') return value !== 0
      return value === 'true' || value === '1'
    } catch (error) {
      console.warn('[PostDeployVerifier] Falha ao verificar flag:', error)
      return true // Em caso de erro, assume ativo
    }
  }

  private mapStatus(verdictStatus: string): string {
    switch (verdictStatus) {
      case 'CONSISTENTE': return 'consistent'
      case 'INCONGRUENTE': return 'incongruent'
      case 'INCONCLUSIVO': return 'inconclusive'
      default: return 'unknown'
    }
  }

  private async safeRecord(batchId: string, evento: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.events.record(`batch:${batchId}`, evento, 'motor', payload)
    } catch {
      // Auditoria nunca derruba o fluxo principal
    }
  }

  private async logOperation(
    batchId: string,
    phase: OperationPhase,
    outcome: OperationOutcome,
    message: QueueMessage,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const operationId = randomUUID()
    await this.logger?.append({
      operationId,
      sequence: 1,
      phase,
      outcome,
      messageId: message.messageId,
      messageType: message.type,
      correlationId: message.correlationId,
      causationId: message.causationId,
      taskId: message.taskId,
      batchId,
      ...(extra as any),
    })
  }

  private async logError(reasonCode: string, message: QueueMessage): Promise<void> {
    await this.logOperation('unknown', 'failed', 'failed', message, { reasonCode })
  }
}
