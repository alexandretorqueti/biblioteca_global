import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { QueueMessage } from '../queue/index.js'
import { insertOutboxMessage } from '../queue/index.js'
import type { PrimitiveContext } from '../primitives/types.js'
import type { WorkerLauncher } from '../worker-launcher/WorkerLauncher.js'
import type { GitWorktreePreparer } from '../execution/GitWorktreePreparer.js'
import type { TaskEventSink } from '../coordinator/TaskEventRecorder.js'
import { loadActiveBlocker, type ActiveBlockerRow } from './ActiveBlockerLookup.js'
import { ConsoleHumanNotifier, type MonitorHumanNotifier } from './HumanNotifier.js'
import { MonitorPromptResolver } from './MonitorPromptResolver.js'
import { parseMonitorVerdict, type MonitorVerdict } from './MonitorVerdictParser.js'
import {
  TASK_BLOCKED_EVENT_TYPE,
  createTaskUnblockedMessage,
  type TaskBlockedPayload,
} from './TaskBlockedEvent.js'

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
  paused_at: Date | null
}

/**
 * Monitor-Resolvedor de bloqueios (especificação:
 * gerenteagentes/docs/MONITOR-RESOLVEDOR-DE-BLOQUEIOS.md).
 *
 * Consome `TASK_BLOCKED`, carrega o contexto da tarefa/bloqueio, resolve o
 * prompt ativo `monitor.resolucao_bloqueio` da tabela de prompts e executa a
 * missão com a cadeia de modelos MONITOR do projeto.
 *
 * Fluxo completo (etapas 3+4):
 * - mensagem no chat da tarefa ao iniciar a investigação;
 * - execução da missão com auditoria em `tarefa_eventos`
 *   (`monitor_resolution_started` / `monitor_resolution_finished`);
 * - parse do veredito (STATUS/ORIGEM/CAUSA/.../MENSAGEM_CHAT);
 * - STATUS=RESOLVIDO → desbloqueio (`resolved_at`) + evento `TASK_UNBLOCKED`
 *   na mesma transação + mensagem de resolução no chat;
 * - demais status → bloqueio permanece + mensagem no chat explicando o que falta.
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
    private readonly notifier: MonitorHumanNotifier = new ConsoleHumanNotifier(),
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
      if (context.paused_at) {
        // Pausa é decisão do usuário: o Monitor não mexe na tarefa. O resume
        // (TASK_RESUME_REQUESTED) reemite TASK_BLOCKED e o Monitor é chamado.
        await this.safeRecord(taskId, 'monitor_resolution_skipped', { blockId: blocker.id, reason: 'tarefa_pausada' })
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
      await this.safePostChat(Number(blocker.tarefa_id), [
        `🔧 Monitor: investigando bloqueio \`${blocker.block_reason}\`.`,
        blocker.block_excerpt ? `Evidência: ${String(blocker.block_excerpt).slice(0, 500)}` : null,
      ].filter(Boolean).join('\n'))
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
      await this.applyVerdict(taskId, blocker, result.success, result.response ?? null, result.error ?? null)
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

  /**
   * Etapa 4 — aplica o veredito do Monitor:
   * - RESOLVIDO (com worker success) → desbloqueia + TASK_UNBLOCKED + chat;
   * - PARCIALMENTE_RESOLVIDO / NAO_RESOLVIDO / resposta fora do contrato /
   *   worker sem sucesso → bloqueio permanece + chat explica o que falta.
   */
  private async applyVerdict(
    taskId: string,
    blocker: ActiveBlockerRow,
    workerSuccess: boolean,
    response: string | null,
    workerError: string | null,
  ): Promise<void> {
    if (!workerSuccess || response == null) {
      const summary = workerError ? `Erro na execução: ${workerError.slice(0, 500)}` : 'O worker não retornou resposta.'
      await this.safePostChat(Number(blocker.tarefa_id), [
        `❌ Monitor: não foi possível resolver o bloqueio \`${blocker.block_reason}\`.`,
        summary,
        'O bloqueio permanece ativo para revisão.',
      ].join('\n'))
      await this.safeNotify(taskId, blocker.block_reason, summary)
      await this.safeRecord(taskId, 'monitor_resolution_kept_blocked', { blockId: blocker.id, reason: 'worker_sem_sucesso' })
      return
    }
    const verdict = parseMonitorVerdict(response)
    if (verdict.status === 'RESOLVIDO') {
      const unblocked = await this.resolveBlocker(taskId, blocker, verdict)
      await this.safePostChat(Number(blocker.tarefa_id), [
        `✅ Monitor: bloqueio \`${blocker.block_reason}\` resolvido (origem: ${verdict.origin}).`,
        verdict.chatMessage,
      ].join('\n\n'))
      await this.safeRecord(taskId, 'monitor_resolution_unblocked', {
        blockId: blocker.id, origin: verdict.origin, unblocked,
      })
      return
    }
    // PARCIALMENTE_RESOLVIDO, NAO_RESOLVIDO ou resposta não parseável:
    // conservador — o bloqueio permanece para revisão humana/outra tentativa.
    await this.safePostChat(Number(blocker.tarefa_id), [
      `⚠️ Monitor: bloqueio \`${blocker.block_reason}\` NÃO resolvido completamente (status: ${verdict.status}, origem: ${verdict.origin}).`,
      verdict.chatMessage,
      verdict.resumption ? `Retomada: ${verdict.resumption}` : null,
    ].filter(Boolean).join('\n\n'))
    await this.safeNotify(taskId, blocker.block_reason, `status=${verdict.status} origem=${verdict.origin} parseable=${verdict.parseable}. ${verdict.cause || verdict.chatMessage}`.slice(0, 1000))
    await this.safeRecord(taskId, 'monitor_resolution_kept_blocked', {
      blockId: blocker.id, status: verdict.status, origin: verdict.origin, parseable: verdict.parseable,
    })
  }

  /**
   * Desbloqueia gravando `resolved_at` e emitindo `TASK_UNBLOCKED` na MESMA
   * transação (atomicidade fato+evento). Retorna true se a linha foi atualizada
   * (false quando outro fluxo já havia resolvido — corrida benigna).
   */
  private async resolveBlocker(taskId: string, blocker: ActiveBlockerRow, verdict: MonitorVerdict): Promise<boolean> {
    const unblocked = createTaskUnblockedMessage({
      taskId,
      executionId: `unblock-${blocker.id}-${Date.now()}`,
      payload: {
        blockId: Number(blocker.id),
        blockReason: blocker.block_reason,
        databaseTaskId: Number(blocker.tarefa_id),
        verdictStatus: verdict.status,
        verdictOrigin: verdict.origin,
        resolvedBy: 'monitor',
      },
    })
    const connection: PoolConnection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [result] = await connection.query<ResultSetHeader>(
        'UPDATE bloqueios SET resolved_at = NOW() WHERE id = ? AND resolved_at IS NULL',
        [blocker.id],
      )
      const updated = result.affectedRows > 0
      if (updated) await insertOutboxMessage(connection, unblocked)
      await connection.commit()
      return updated
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /** Mensagem no chat da tarefa (mesmo padrão do TestRecoveryConsumer). */
  private async safePostChat(databaseTaskId: number, texto: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO tarefa_chats (tarefa_id, role, texto, created_at) VALUES (?, 'assistant', ?, NOW())`,
        [databaseTaskId, texto.slice(0, 8000)],
      )
    } catch {
      // Chat nunca derruba o fluxo principal; o evento de auditoria permanece.
    }
  }

  /** Notificação humana quando o Monitor não resolve; nunca derruba o fluxo. */
  private async safeNotify(taskId: string, blockReason: string, summary: string): Promise<void> {
    try {
      await this.notifier.notify({ taskId, blockReason, summary })
    } catch {
      // Notificação é melhor-esforço.
    }
  }

  /** Localiza o bloqueio ativo (resolved_at IS NULL) referente ao evento. */
  private async findActiveBlocker(taskId: string, payload: Partial<TaskBlockedPayload>): Promise<ActiveBlockerRow | null> {
    return loadActiveBlocker(this.pool, taskId, { blockId: payload.blockId, blockReason: payload.blockReason })
  }

  private async loadContext(taskId: string): Promise<TaskContextRow | null> {
    const [rows] = await this.pool.query<TaskContextRow[]>(
      `SELECT t.id AS database_task_id, COALESCE(NULLIF(t.external_id,''), CAST(t.id AS CHAR)) AS task_id,
              t.titulo, t.projeto_id, pc.slug AS project_slug, pmc.repo_path, pmc.branch_trabalho,
              pmc.build_command, pmc.unit_test_command,
              COALESCE(NULLIF(a.openclaw_agent_id,''), pc.slug) AS agent_id, t.paused_at
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
