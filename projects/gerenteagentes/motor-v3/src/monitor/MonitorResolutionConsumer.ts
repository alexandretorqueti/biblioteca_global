import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from '../queue/index.js'
import type { PrimitiveContext } from '../primitives/types.js'
import type { WorkerLauncher } from '../worker-launcher/WorkerLauncher.js'
import type { GitWorktreePreparer } from '../execution/GitWorktreePreparer.js'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import { MonitorPromptResolver } from './MonitorPromptResolver.js'
import { TASK_BLOCKED_EVENT_TYPE, type TaskBlockedPayload } from './TaskBlockedEvent.js'

interface ActiveBlockerRow extends RowDataPacket {
  id: number
  tarefa_id: number
  subtarefa_id: number | null
  block_reason: string
  block_command: string | null
  block_excerpt: string | null
}

interface TaskContextRow extends RowDataPacket {
  database_task_id: number
  task_id: string
  titulo: string
  projeto_id: number
  project_slug: string
  repo_path: string
  branch_trabalho: string
  build_command: string | null
  unit_test_command: string | null
  agent_id: string
}

/**
 * Monitor-Resolvedor de bloqueios (especificação:
 * gerenteagentes/docs/MONITOR-RESOLVEDOR-DE-BLOQUEIOS.md).
 *
 * Consome `TASK_BLOCKED`, carrega o contexto da tarefa/bloqueio, resolve o
 * prompt ativo `monitor.resolucao_bloqueio` da tabela de prompts e executa a
 * missão com a cadeia de modelos MONITOR do projeto.
 *
 * Etapa 3: execução da missão + auditoria em `tarefa_eventos`
 * (`monitor_resolution_started` / `monitor_resolution_finished`). O parse do
 * veredito, o desbloqueio e a mensagem no chat da tarefa vêm na etapa 4.
 *
 * Idempotência:
 * - bloqueio já resolvido → ignora (redelivery não re-executa);
 * - guarda em memória por blockId (instância única do Motor, mesma premissa
 *   de activeWorkers/finalizingExecutions — ver MEMORY.md).
 */
export class MonitorResolutionConsumer {
  private readonly inFlight = new Set<number>()

  constructor(
    private readonly pool: Pool,
    private readonly worktrees: GitWorktreePreparer,
    private readonly worker: Pick<WorkerLauncher, 'executeTask'>,
    private readonly prompts: MonitorPromptResolver,
    private readonly events: TaskEventSink,
    private readonly consoleApi: unknown,
    private readonly db: unknown,
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== TASK_BLOCKED_EVENT_TYPE) return
    const payload = (message.payload ?? {}) as Partial<TaskBlockedPayload>
    const blocker = await this.findActiveBlocker(message.taskId, payload)
    // Bloqueio já resolvido (ou tarefa inexistente): redelivery não age.
    if (!blocker) return
    if (this.inFlight.has(Number(blocker.id))) return
    this.inFlight.add(Number(blocker.id))
    try {
      await this.runMission(message, blocker)
    } finally {
      this.inFlight.delete(Number(blocker.id))
    }
  }

  private async runMission(message: QueueMessage, blocker: ActiveBlockerRow): Promise<void> {
    const taskId = message.taskId
    try {
      const context = await this.loadContext(taskId)
      if (!context) {
        await this.safeRecord(taskId, 'monitor_resolution_skipped', { blockId: blocker.id, reason: 'tarefa_nao_encontrada' })
        return
      }
      const models = await this.monitorModels(context.project_slug)
      if (models.length === 0) {
        // Sem cadeia MONITOR configurada o bloqueio permanece e o humano é a
        // última ratio (notificação entra na etapa 4).
        await this.safeRecord(taskId, 'monitor_resolution_skipped', { blockId: blocker.id, reason: 'sem_modelos_monitor' })
        return
      }
      const devBranch = await this.devBranches(Number(blocker.tarefa_id))
      const workspace = await this.worktrees.prepareIntegration({
        taskId: context.task_id,
        repoPath: context.repo_path,
        baseBranch: context.branch_trabalho,
      })
      const prompt = await this.prompts.resolve(taskId, {
        taskId: context.task_id,
        taskTitle: context.titulo,
        subtaskId: blocker.subtarefa_id != null ? String(blocker.subtarefa_id) : '—',
        repository: context.repo_path,
        baseBranch: context.branch_trabalho,
        devBranch: devBranch || '—',
        integrationBranch: workspace.branch,
        workspace: workspace.path,
        blockReason: blocker.block_reason,
        blockCommand: blocker.block_command ?? '—',
        evidence: (payloadExcerpt(blocker) ?? '—').slice(0, 4000),
      })
      await this.safeRecord(taskId, 'monitor_resolution_started', {
        blockId: blocker.id, blockReason: blocker.block_reason, models, promptExecutionId: prompt.executionRowId,
      })
      const execution: PrimitiveContext = {
        taskId: context.task_id,
        databaseTaskId: Number(context.database_task_id),
        projectId: Number(context.projeto_id),
        subtaskId: blocker.subtarefa_id != null ? Number(blocker.subtarefa_id) : undefined,
        executionId: message.executionId,
        generation: 1,
        projectSlug: context.project_slug,
        repoPath: context.repo_path,
        worktreePath: workspace.path,
        branchName: workspace.branch,
        baseCommitSha: workspace.baseCommit,
        buildCommand: context.build_command ?? undefined,
        testCommand: context.unit_test_command ?? undefined,
        agentId: context.agent_id,
        db: this.db,
        consoleApi: this.consoleApi,
        logger: console,
      }
      // allowNoChanges: o Monitor pode concluir sem alterar arquivos (ex.:
      // origem EXTERNO, ou decidir apenas desbloquear a tarefa).
      const result = await this.worker.executeTask(execution, prompt.text, models, undefined, undefined, true)
      await this.safeRecord(taskId, 'monitor_resolution_finished', {
        blockId: blocker.id,
        blockReason: blocker.block_reason,
        success: result.success,
        attempts: result.attempts,
        model: result.model ?? null,
        error: result.error ?? null,
        response: result.response != null ? String(result.response).slice(0, 4000) : null,
      })
    } catch (error) {
      // Falha da missão não propaga para a fila (evita loop de redelivery):
      // o bloqueio permanece ativo e o evento registra a causa.
      await this.safeRecord(taskId, 'monitor_resolution_failed', {
        blockId: blocker.id,
        blockReason: blocker.block_reason,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Localiza o bloqueio ativo (resolved_at IS NULL) referente ao evento. */
  private async findActiveBlocker(taskId: string, payload: Partial<TaskBlockedPayload>): Promise<ActiveBlockerRow | null> {
    const where = taskWhere(taskId)
    const taskParams = taskParamsFor(taskId)
    if (payload.blockId != null) {
      const [rows] = await this.pool.query<ActiveBlockerRow[]>(
        `SELECT b.id, b.tarefa_id, b.subtarefa_id, b.block_reason, b.block_command, b.block_excerpt
           FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id
          WHERE b.id = ? AND b.resolved_at IS NULL AND ${where} LIMIT 1`,
        [payload.blockId, ...taskParams],
      )
      if (rows[0]) return rows[0]
      // blockId do evento já resolvido: segue para busca por motivo (o evento
      // pode ter sido emitido para um bloqueio antigo já tratado).
    }
    const reasonFilter = payload.blockReason ? 'AND b.block_reason = ?' : ''
    const params = payload.blockReason ? [...taskParams, payload.blockReason] : [...taskParams]
    const [rows] = await this.pool.query<ActiveBlockerRow[]>(
      `SELECT b.id, b.tarefa_id, b.subtarefa_id, b.block_reason, b.block_command, b.block_excerpt
         FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id
        WHERE ${where} AND b.resolved_at IS NULL ${reasonFilter}
        ORDER BY b.id DESC LIMIT 1`,
      params,
    )
    return rows[0] ?? null
  }

  private async loadContext(taskId: string): Promise<TaskContextRow | null> {
    const [rows] = await this.pool.query<TaskContextRow[]>(
      `SELECT t.id AS database_task_id, COALESCE(NULLIF(t.external_id,''), CAST(t.id AS CHAR)) AS task_id,
              t.titulo, t.projeto_id, pc.slug AS project_slug, pmc.repo_path, pmc.branch_trabalho,
              pmc.build_command, pmc.unit_test_command,
              COALESCE(NULLIF(a.openclaw_agent_id,''), pc.slug) AS agent_id
         FROM tarefas t
         JOIN projetos_captados pc ON pc.id = t.projeto_id
         JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id
         LEFT JOIN agentes a ON a.id = pc.agente_id
        WHERE ${taskWhere(taskId)} LIMIT 1`,
      taskParamsFor(taskId),
    )
    return rows[0] ?? null
  }

  /** Cadeia de modelos MONITOR do projeto (mesma fonte do TestRecoveryConsumer). */
  private async monitorModels(projectSlug: string): Promise<string[]> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { model: string }>>(
      `SELECT model FROM project_model_selection WHERE project_slug=? AND tipo='MONITOR' AND enabled=1 ORDER BY ordem`,
      [projectSlug],
    )
    return rows.map(row => String(row.model)).filter(Boolean)
  }

  /** Branches de trabalho das subtarefas (contexto para o prompt). */
  private async devBranches(databaseTaskId: number): Promise<string> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { workspace_branch: string }>>(
      `SELECT DISTINCT workspace_branch FROM subtarefas
        WHERE tarefa_id = ? AND workspace_branch IS NOT NULL AND workspace_branch <> ''
        ORDER BY workspace_branch`,
      [databaseTaskId],
    )
    return rows.map(row => String(row.workspace_branch)).join('\n')
  }

  private async safeRecord(taskId: string, evento: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.events.record(taskId, evento, 'motor', payload)
    } catch {
      // Auditoria nunca derruba o fluxo principal (contrato do TaskEventSink).
    }
  }
}

function payloadExcerpt(blocker: ActiveBlockerRow): string | null {
  return blocker.block_excerpt != null ? String(blocker.block_excerpt) : null
}

function taskWhere(taskId: string): string {
  return /^\d+$/.test(taskId) ? '(t.external_id = ? OR CAST(t.id AS CHAR) = ?)' : 't.external_id = ?'
}

function taskParamsFor(taskId: string): unknown[] {
  return /^\d+$/.test(taskId) ? [taskId, taskId] : [taskId]
}
