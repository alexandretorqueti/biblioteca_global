/**
 * TaskCoordinator - Coordenador principal do Motor v2
 * 
 * Fluxo:
 * 1. Seleciona tarefa planejada -> chama Analista (cria subtarefas)
 * 2. Seleciona subtarefa pendente -> prepara workspace + executa + testa + deploy
 */

import type { Db, TaskRepository } from "../shared/types/infrastructure.js"
import type { Task } from "../shared/types/index.js"
import type { ResourceKey } from "../shared/types/resources.js"
import type { ExecutionResult, SubtaskInfo } from "../shared/types/execution.js"
import { ResourceLeaseService } from "../resources/ResourceLeaseService.js"
import { RESOURCE_KEYS } from "../shared/types/resources.js"
import { WorkerLauncher } from "../workers/WorkerLauncher.js"
import { defaultChain, type ModelPhase, type ModelSelection } from "../policies/ModelTierPolicy.js"
import { GitWorkspaceManager } from "../workspaces/GitWorkspaceManager.js"
import { ResourceWaitManager } from "../resources/ResourceWaitManager.js"
import { executionEventBus, type ExecutionEventBus } from "../events/ExecutionEventBus.js"
import { correctionOnlyChangesTests } from "../policies/CorrectionDiffPolicy.js"
import { blockerEvidence } from "../policies/BlockerPolicy.js"
import { transitionTask, type TaskTransition } from "../policies/TaskStateMachine.js"
import { createLogger, describeError } from "../shared/logger.js"

interface ActiveWorker {
  taskId: string
  executionId: string
  resourceKey: ResourceKey | null
  fencingToken: number
  startedAt: Date
  phase: "analyze" | "execute"
  subtaskId?: number
  workspace?: { path: string; branch: string; baseCommit: string }
  repoPath?: string
  projectSlug?: string
  baseBranch?: string
  timeoutHandle?: ReturnType<typeof setTimeout>
  lastHeartbeatAt?: Date
  silenceHandle?: ReturnType<typeof setTimeout>
}

export interface TaskCoordinatorConfig {
  maxWorkers: number
  maxWorkersPerProject: number
  /** Timeout máximo de um worker; quando omitido usa hard_timeout_ms da tarefa. */
  workerTimeoutMs?: number
}

const DEFAULT_CONFIG: TaskCoordinatorConfig = {
  maxWorkers: 1,
  maxWorkersPerProject: 1,
}

interface UltimoBloqueio {
  kind: string
  excerpt: string
  blockedAt: string
  subtaskId: number | null
}

interface SubtaskView {
  id: number
  seq: number
  titulo: string
  status: string
  resultado: string | null
  deliverCount: number
  workspaceStatus: string | null
  workspaceBranch: string | null
  workspaceCommitSha: string | null
  correctionForSubtaskId: number | null
}

interface SubtaskWithTask {
  id: number
  seq: number
  titulo: string
  scope?: string
  acceptanceCriteria?: string[]
  tarefaId: number
  taskExternalId: string
  taskTitulo: string
  taskDescricao: string
  repoPath: string
  projectSlug: string | null
  branchTrabalho: string | null
  agentId: string
  buildCommand: string | null
  unitTestCommand: string | null
  unitTestExclude: string[]
  maxRework: number | null
  hardTimeoutMs: number | null
  deliverCount: number
}

export class TaskCoordinator {
  private config: TaskCoordinatorConfig
  private activeWorkers = new Map<string, ActiveWorker>()
  private resourceLease: ResourceLeaseService
  private workerLauncher: WorkerLauncher
  private db: Db
  private repository: TaskRepository
  private workspaceManager: GitWorkspaceManager
  private waitManager?: ResourceWaitManager
  private eventBus: ExecutionEventBus
  private finalizingExecutions = new Set<string>()
  private pumping = false
  private logger = createLogger("TaskCoordinator")

  constructor(
    db: Db,
    repository: TaskRepository,
    resourceLease: ResourceLeaseService,
    config: Partial<TaskCoordinatorConfig> = {},
    workerLauncher = new WorkerLauncher(),
    workspaceManager = new GitWorkspaceManager({ root: process.env.MOTOR_WORKSPACE_ROOT ?? "/tmp/motor-v2-workspaces" }),
    waitManager?: ResourceWaitManager,
    eventBus = executionEventBus,
  ) {
    this.db = db
    this.repository = repository
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.resourceLease = resourceLease
    this.workerLauncher = workerLauncher
    this.workspaceManager = workspaceManager
    this.waitManager = waitManager
    this.eventBus = eventBus
    this.setupEventHandlers()
  }

  async pump(): Promise<void> {
    // Releases de lease e chamadas HTTP podem disparar o pump ao mesmo tempo.
    // Sem essa trava, duas chamadas selecionam a mesma subtarefa antes de ela
    // ser persistida como running: uma inicia o worker e a outra a coloca na
    // fila, sobrescrevendo indevidamente o status da tarefa para paused.
    if (this.pumping) return
    this.pumping = true
    try {
      // Com maxWorkers > 1 um único pump precisa preencher todas as vagas;
      // cada iteração inicia no máximo um worker e reconsulta a fila. O laço
      // para quando não há trabalho elegível ou quando o trabalho selecionado
      // não pôde iniciar (recurso em espera, falha de início).
      let guard = 0
      while (this.activeWorkers.size < this.config.maxWorkers && guard <= this.config.maxWorkers) {
        guard += 1

        // 1. Tenta pegar subtarefa pendente (execucao)
        const subtask = await this.selectNextSubtask()
        if (subtask) {
          this.logger.info("Subtarefa selecionada: #" + subtask.seq + " " + subtask.titulo, {
            taskId: subtask.taskExternalId, subtaskId: subtask.id, projectSlug: subtask.projectSlug ?? undefined,
          })
          const started = await this.startSubtaskExecution(subtask)
          if (!started) break
          continue
        }

        // 2. Se nao tem subtarefa, pega tarefa planejada (analise)
        const task = await this.selectNextTask()
        if (task) {
          this.logger.info("Tarefa selecionada para analise: " + task.id + " (" + task.title + ")", {
            taskId: task.id, projectSlug: task.projectSlug ?? undefined,
          })
          const started = await this.startTaskAnalysis(task)
          if (!started) break
          continue
        }
        break
      }
    } finally {
      this.pumping = false
    }
  }

  private async selectNextTask(): Promise<Task | null> {
    const { rows } = await this.db.query(
      "SELECT t.*, pc.slug as project_slug, a.nome as agent_id, " +
      "pmc.repo_path, pmc.branch_trabalho, pmc.build_command, pmc.unit_test_command, pmc.unit_test_exclude, " +
      "pmc.default_max_rework, pmc.default_hard_timeout_ms " +
      "FROM projeto_640.tarefas t " +
      "LEFT JOIN projeto_640.projetos_captados pc ON t.projeto_id = pc.id " +
      "LEFT JOIN projeto_640.agentes a ON pc.agente_id = a.id " +
      "LEFT JOIN projeto_640.projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
      "WHERE t.status = 'planned' AND NOT EXISTS (SELECT 1 FROM projeto_640.subtarefas s WHERE s.tarefa_id = t.id) ORDER BY t.created_at ASC LIMIT 25"
    )
    return rows.map((row) => this.mapTask(row)).find((task) => this.canStartProject(task.projectSlug)) ?? null
  }

  private async selectNextSubtask(): Promise<SubtaskWithTask | null> {
    const { rows } = await this.db.query(
      "SELECT s.*, t.external_id as task_external_id, t.titulo as task_titulo, t.descricao as task_descricao, " +
      "t.max_rework AS task_max_rework, t.hard_timeout_ms AS task_hard_timeout_ms, " +
      "pc.slug as project_slug, a.nome as agent_id, " +
      "pmc.repo_path, pmc.branch_trabalho, pmc.build_command, pmc.unit_test_command, pmc.unit_test_exclude, " +
      "pmc.default_max_rework, pmc.default_hard_timeout_ms " +
      "FROM projeto_640.subtarefas s " +
      "INNER JOIN projeto_640.tarefas t ON s.tarefa_id = t.id " +
      "LEFT JOIN projeto_640.projetos_captados pc ON t.projeto_id = pc.id " +
      "LEFT JOIN projeto_640.agentes a ON pc.agente_id = a.id " +
      "LEFT JOIN projeto_640.projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
      "WHERE s.status = 'pending' AND t.status = 'ready' " +
      "AND NOT EXISTS (" +
      "SELECT 1 FROM projeto_640.subtarefas anterior " +
      "WHERE anterior.tarefa_id = s.tarefa_id AND anterior.seq < s.seq AND anterior.status != 'verified' " +
      "AND anterior.id != COALESCE(s.correction_for_subtask_id, -1)" +
      ") " +
      "ORDER BY s.seq ASC LIMIT 25"
    )
    return rows.map((row) => this.mapSubtask(row)).find((subtask) => this.canStartProject(subtask.projectSlug)) ?? null
  }

  private canStartProject(projectSlug: string | null): boolean {
    if (!projectSlug) return true
    let runningForProject = 0
    for (const worker of this.activeWorkers.values()) {
      if (worker.resourceKey === RESOURCE_KEYS.projectExecution(projectSlug)) runningForProject += 1
    }
    return runningForProject < this.config.maxWorkersPerProject
  }

  /** Retorna true quando o worker foi iniciado; false quando o trabalho não começou (espera/falha). */
  private async startTaskAnalysis(task: Task): Promise<boolean> {
    const executionId = "exec-analyze-" + task.id + "-" + Date.now()
    const resourceKey = task.projectSlug ? RESOURCE_KEYS.projectExecution(task.projectSlug) : null
    let fencingToken = 0

    if (resourceKey) {
      const result = await this.resourceLease.acquire(resourceKey, executionId, task.id, 60)
      if (result.kind === "waiting") {
        await this.waitManager?.waitForResource(task.id, resourceKey, result.waitId, result.position)
        this.logger.info("Tarefa " + task.id + " aguardando recurso", { taskId: task.id, projectSlug: task.projectSlug ?? undefined })
        return false
      }
      if (result.kind !== "acquired") throw new Error("Falha ao adquirir recurso: " + result.reason)
      fencingToken = result.lease.fencingToken
    }

    this.activeWorkers.set(executionId, {
      taskId: task.id, executionId, resourceKey, fencingToken,
      startedAt: new Date(), phase: "analyze",
      projectSlug: task.projectSlug ?? undefined,
    })

    try {
      await this.saveTaskTransition(task, "start_analysis", { executionId })

      await this.workerLauncher.spawn({
        context: {
          executionId, taskId: task.id, projectSlug: task.projectSlug,
          phase: "analyze", fencingToken, startedAt: new Date(),
        },
        task, repoPath: task.repoPath,
        buildCommand: task.buildCommand, testCommand: task.unitTestCommand,
        modelPhase: "analysis",
        modelChain: await this.getProjectModelChain(task.projectSlug, "analysis"),
      })
      this.armWorkerTimeout(executionId, task.hardTimeoutMs)

      this.logger.info("Worker de analise iniciado: " + task.id + " (" + executionId + ")", {
        taskId: task.id, executionId, phase: "analyze",
      })
      return true
    } catch (error) {
      this.logger.error("Erro ao iniciar analise: " + describeError(error), { taskId: task.id, executionId, phase: "analyze" })
      if (resourceKey) await this.resourceLease.release(resourceKey, executionId, fencingToken)
      this.activeWorkers.delete(executionId)
      return false
    }
  }

  /** Retorna true quando o worker foi iniciado; false quando o trabalho não começou (espera/falha). */
  private async startSubtaskExecution(subtask: SubtaskWithTask): Promise<boolean> {
    const executionId = "exec-execute-" + subtask.id + "-" + Date.now()
    const resourceKey = subtask.projectSlug ? RESOURCE_KEYS.projectExecution(subtask.projectSlug) : null
    let fencingToken = 0

    if (resourceKey) {
      const result = await this.resourceLease.acquire(resourceKey, executionId, String(subtask.tarefaId), 120)
      if (result.kind === "waiting") {
        await this.waitManager?.waitForResource(String(subtask.tarefaId), resourceKey, result.waitId, result.position)
        this.logger.info("Subtarefa #" + subtask.seq + " aguardando recurso", {
          taskId: subtask.taskExternalId, subtaskId: subtask.id, projectSlug: subtask.projectSlug ?? undefined,
        })
        return false
      }
      if (result.kind !== "acquired") throw new Error("Falha ao adquirir recurso: " + result.reason)
      fencingToken = result.lease.fencingToken
    }

    this.activeWorkers.set(executionId, {
      taskId: subtask.taskExternalId, executionId, resourceKey, fencingToken,
      startedAt: new Date(), phase: "execute", subtaskId: subtask.id,
      repoPath: subtask.repoPath,
      projectSlug: subtask.projectSlug ?? undefined,
    })

    try {
      if (!subtask.agentId) throw new Error("Projeto sem agente configurado")
      this.assertExecutionConfig(subtask)
      // Marca subtarefa como running
      await this.db.query("UPDATE projeto_640.subtarefas SET status = 'running', iniciada_em = NOW() WHERE id = ?", [subtask.id])
      const parentTask = await this.repository.getTask(subtask.taskExternalId)
      if (parentTask) {
        await this.saveTaskTransition(parentTask, "start_execution")
      }
      const baseBranch = subtask.branchTrabalho || "base-desenvolvimento"
      const activeWorkerForBranch = this.activeWorkers.get(executionId)
      if (activeWorkerForBranch) activeWorkerForBranch.baseBranch = baseBranch
      const workspace = await this.workspaceManager.prepare({
        repoPath: subtask.repoPath,
        baseBranch,
        taskId: subtask.taskExternalId,
        subtaskId: String(subtask.id),
        attempt: Math.max(1, subtask.deliverCount + 1),
      })
      const activeWorker = this.activeWorkers.get(executionId)
      if (activeWorker) activeWorker.workspace = workspace
      await this.db.query(
        "UPDATE projeto_640.subtarefas SET workspace_path = ?, workspace_branch = ?, workspace_base_commit = ?, workspace_status = 'active', workspace_created_at = NOW(), workspace_cleaned_at = NULL WHERE id = ?",
        [workspace.path, workspace.branch, workspace.baseCommit, subtask.id],
      )

      const subtaskInfo: SubtaskInfo = {
        id: subtask.id, seq: subtask.seq, titulo: subtask.titulo,
        scope: subtask.scope, acceptanceCriteria: subtask.acceptanceCriteria,
        deliverCount: subtask.deliverCount,
      }

      const task: Task = {
        id: subtask.taskExternalId, chatId: "", agentId: subtask.agentId,
        title: subtask.taskTitulo, description: subtask.taskDescricao,
        repoPath: subtask.repoPath, buildCommand: subtask.buildCommand!,
        unitTestCommand: subtask.unitTestCommand!, unitTestExclude: subtask.unitTestExclude,
        baselineMode: "full", status: "running",
        maxRework: subtask.maxRework ?? 3, hardTimeoutMs: subtask.hardTimeoutMs ?? 3600000,
        projectSlug: subtask.projectSlug,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }

      await this.workerLauncher.spawn({
        context: {
          executionId, taskId: subtask.taskExternalId, projectSlug: subtask.projectSlug,
          phase: "execute", fencingToken, startedAt: new Date(),
          subtaskId: String(subtask.id),
        },
        task, repoPath: workspace.path,
        buildCommand: subtask.buildCommand!, testCommand: subtask.unitTestCommand!,
        subtask: subtaskInfo,
        workBranch: workspace.branch,
        baseBranch,
        modelPhase: "development",
        modelChain: await this.getProjectModelChain(subtask.projectSlug, "development"),
      })
      this.armWorkerTimeout(executionId, subtask.hardTimeoutMs ?? 3600000)

      this.logger.info("Worker de execucao iniciado: subtarefa #" + subtask.seq + " (" + executionId + ")", {
        taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId, phase: "execute",
        projectSlug: subtask.projectSlug ?? undefined,
      })
      return true
    } catch (error) {
      const reason = error instanceof Error ? (error.message || String(error)) : String(error)
      const transientDb = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|PROTOCOL_CONNECTION_LOST|Connection lost/i.test(reason)
      // Qualquer falha no preparo/início (repo ausente, configuração ausente,
      // git indisponível) não pode entrar em loop de retry: persistir bloqueio
      // e marcar subtarefa/tarefa como bloqueadas. Falhas transientes de banco
      // ficam pendentes para o próximo pump.
      if (!transientDb) {
        try {
          const environmental = reason.startsWith("Ambiente bloqueado") || reason.includes("ENOENT")
          const evidence = blockerEvidence(environmental ? "blocked_environment" : "systemic_failure", reason)
          await this.db.query(
            "INSERT INTO projeto_640.bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
            "SELECT tarefa_id, ?, ?, ?, ?, NOW() FROM projeto_640.subtarefas WHERE id = ?",
            [subtask.id, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, subtask.id],
          )
          await this.db.query("UPDATE projeto_640.subtarefas SET status = 'blocked', updated_at = NOW() WHERE id = ?", [subtask.id])
          const parentTask = await this.repository.getTask(subtask.taskExternalId)
          if (parentTask) await this.saveTaskTransition(parentTask, "fail")
          this.logger.warn("Bloqueio persistido no inicio da execucao (subtarefa " + subtask.id + "): " + reason, {
            taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId,
          })
        } catch (persistError) {
          this.logger.error("Falha ao persistir bloqueio de inicio: " + describeError(persistError), {
            taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId,
          })
        }
      } else {
        this.logger.warn("Falha transiente ao iniciar execucao (subtarefa permanece pending): " + reason, {
          taskId: subtask.taskExternalId, subtaskId: subtask.id, executionId,
        })
      }
      const activeWorker = this.activeWorkers.get(executionId)
      if (activeWorker && this.beginFinalization(executionId, activeWorker)) {
        await this.finishWorker(executionId, activeWorker)
      } else if (resourceKey) {
        await this.resourceLease.release(resourceKey, executionId, fencingToken)
      }
      return false
    }
  }

  async onTaskCompleted(executionId: string, result?: ExecutionResult): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return

    try {
    if (worker.phase === "analyze") {
      this.publishActivity(worker, { type: "completed" })
      this.logger.info("Analise completada: " + worker.taskId, { taskId: worker.taskId, executionId, phase: "analyze" })
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.saveTaskTransition(task, "analysis_completed")
      }
    } else {
      this.logger.info("Execucao completada: subtarefa " + worker.subtaskId, { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId, phase: "execute" })
      if (worker.subtaskId && worker.workspace) {
        try {
          let mergeCommit: string | undefined
          if (result?.gitCommitSha) {
            if (!worker.repoPath || !worker.baseBranch) {
              throw new Error("entrega aprovada sem repositório ou branch-base para integração")
            }
            const integration = await this.workspaceManager.integrate({
              repoPath: worker.repoPath,
              baseBranch: worker.baseBranch,
              workBranch: worker.workspace.branch,
              expectedCommit: result.gitCommitSha,
            })
            mergeCommit = integration.mergeCommit
          }
          await this.db.query(
            "UPDATE projeto_640.subtarefas SET workspace_commit_sha = ?, workspace_status = ? WHERE id = ?",
            [result?.gitCommitSha ?? null, mergeCommit ? "integrated" : "approved", worker.subtaskId],
          )
          if (mergeCommit) {
            this.publishActivity(worker, {
              type: "developer_branch_integrated",
              executionPhase: "publish",
              level: "info",
              message: `Branch ${worker.workspace.branch} integrada em ${worker.baseBranch} (${mergeCommit})`,
            })
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          await this.db.query(
            "UPDATE projeto_640.subtarefas SET workspace_status = 'integration_failed', resultado = ? WHERE id = ?",
            [reason.substring(0, 500), worker.subtaskId],
          )
          // Falha de integração também deixa trilha em bloqueios — sem isso só
          // o errorMessage registrava o ocorrido.
          try {
            const evidence = blockerEvidence("systemic_failure", "Integração falhou: " + reason)
            await this.db.query(
              "INSERT INTO projeto_640.bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at) " +
              "SELECT tarefa_id, ?, ?, ?, ?, NOW() FROM projeto_640.subtarefas WHERE id = ?",
              [worker.subtaskId, evidence.kind, "motor-v2:" + evidence.fingerprint, evidence.excerpt, worker.subtaskId],
            )
          } catch (persistError) {
            this.logger.error("Falha ao persistir bloqueio de integracao: " + describeError(persistError), {
              taskId: worker.taskId, subtaskId: worker.subtaskId, executionId,
            })
          }
          this.logger.error("Integracao falhou: " + reason, { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId })
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            await this.saveTaskTransition(task, "fail", { errorMessage: reason.substring(0, 500) })
          }
          this.publishActivity(worker, { type: "failed", level: "error", message: reason })
          await this.finishWorker(executionId, worker)
          return
        }
        await this.promoteOriginalAfterTestOnlyCorrection(worker.subtaskId, worker.workspace, result?.gitCommitSha)
      }

      this.publishActivity(worker, { type: "completed" })
      
      // Verificar se todas subtarefas da tarefa estao completas
      if (worker.subtaskId) {
        const { rows } = await this.db.query(
          "SELECT COUNT(*) as pending FROM projeto_640.subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AND status != 'verified'",
          [worker.subtaskId]
        )
        const pending = (rows[0] as Record<string, unknown>)?.pending as number
        if (pending === 0) {
          this.logger.info("Todas subtarefas completas! Marcando tarefa como completed", { taskId: worker.taskId, executionId })
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            await this.saveTaskTransition(task, "execution_completed")
          }
        } else {
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            await this.saveTaskTransition(task, "subtasks_pending")
          }
        }
      }
    }

    await this.finishWorker(executionId, worker)
    } catch (error) {
      this.logger.error("Falha ao finalizar sucesso da execução " + executionId + ": " + describeError(error), { taskId: worker.taskId, executionId })
      await this.finishWorker(executionId, worker)
      throw error
    }
  }

  async onTaskFailed(executionId: string, error: string, kind = "error"): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return
    const failure = `[${kind}] ${error}`
    const transient = kind === "timeout" || kind === "lease_lost" || kind === "lease_expired" || kind === "lost"
    this.publishActivity(worker, { type: "failed", level: "error", message: failure })

    this.logger.error("Falha: " + failure, { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId, phase: worker.phase })

    try {
      if (worker.phase === "analyze") {
        const task = await this.repository.getTask(worker.taskId)
        if (task) {
          await this.saveTaskTransition(task, transient ? "recover" : "fail", { errorMessage: "Analise falhou: " + failure })
        }
      } else {
        if (worker.subtaskId) {
          await this.db.query(
            "UPDATE projeto_640.subtarefas SET status = ?, resultado = ? WHERE id = ?",
            [transient ? "pending" : "blocked", failure.substring(0, 500), worker.subtaskId],
          )
        }
        const task = await this.repository.getTask(worker.taskId)
        if (task) {
          await this.saveTaskTransition(task, transient ? "recover" : "fail", { errorMessage: failure.substring(0, 500) })
        }
      }
    } finally {
      await this.finishWorker(executionId, worker)
    }
  }

  async onTaskPaused(executionId: string, reason: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || !this.beginFinalization(executionId, worker)) return
    this.logger.info("Tarefa pausada: " + worker.taskId + " - " + reason, { taskId: worker.taskId, executionId })
    // Subtarefa interrompida volta a pendente para o pump retomá-la depois do
    // resume; sem isso ela ficaria órfã em running/verifying para sempre.
    if (worker.subtaskId) {
      await this.db.query(
        "UPDATE projeto_640.subtarefas SET status = 'pending', updated_at = NOW() WHERE id = ? AND status IN ('running', 'verifying', 'delivered', 'rework')",
        [worker.subtaskId],
      ).catch((error: unknown) => this.logger.error("Falha ao resetar subtarefa pausada: " + describeError(error), { taskId: worker.taskId, subtaskId: worker.subtaskId, executionId }))
    }
    const task = await this.repository.getTask(worker.taskId)
    if (task) await this.saveTaskTransition(task, "pause")
    await this.finishWorker(executionId, worker)
  }

  async onResourceReleased(resourceKey: ResourceKey): Promise<void> {
    this.logger.info("Recurso liberado: " + resourceKey)
    await this.waitManager?.resumeNext(resourceKey)
    await this.pump()
  }

  async onLeaseExpired(resourceKey: ResourceKey, executionId: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || worker.resourceKey !== resourceKey) return
    await this.handleWorkerFailure(executionId, `Lease expirado para ${resourceKey}`, "lease_expired")
  }

  getStats() {
    const workers = Array.from(this.activeWorkers.values()).map((worker) => ({
      executionId: worker.executionId,
      taskId: worker.taskId,
      subtaskId: worker.subtaskId ?? null,
      phase: worker.phase,
      projectSlug: worker.projectSlug ?? null,
      startedAt: worker.startedAt.toISOString(),
      ageMs: Date.now() - worker.startedAt.getTime(),
      lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
    }))
    return {
      activeWorkers: this.activeWorkers.size,
      maxWorkers: this.config.maxWorkers,
      maxWorkersPerProject: this.config.maxWorkersPerProject,
      workers,
    }
  }

  async getTask(taskId: string): Promise<Task | null> {
    const data = await this.repository.getTask(taskId)
    if (!data) return null
    return this.mapSaveDataToTask(data)
  }

  /**
   * Tarefa completa com subtarefas e motivo de bloqueio na resposta —
   * remove a dependência do fallback direto no banco pela tela de
   * acompanhamento e dá visibilidade ao motivo de bloqueio.
   */
  async getTaskWithSubtasks(taskId: string): Promise<(Task & { subtasks: SubtaskView[]; errorMessage?: string; ultimoBloqueio: UltimoBloqueio | null }) | null> {
    const data = await this.repository.getTask(taskId)
    if (!data) return null
    const task = this.mapSaveDataToTask(data)
    const isNumeric = /^\d+$/.test(taskId)
    const whereTask = isNumeric ? "WHERE (t.external_id = ? OR t.id = ?) " : "WHERE t.external_id = ? "
    const taskParams = isNumeric ? [taskId, taskId] : [taskId]

    const { rows } = await this.db.query(
      "SELECT s.id, s.seq, s.titulo, s.status, s.resultado, s.deliver_count, " +
      "s.workspace_status, s.workspace_branch, s.workspace_commit_sha, s.correction_for_subtask_id " +
      "FROM projeto_640.subtarefas s " +
      "INNER JOIN projeto_640.tarefas t ON t.id = s.tarefa_id " +
      whereTask +
      "ORDER BY s.seq ASC, s.id ASC",
      taskParams,
    )
    const subtasks: SubtaskView[] = rows.map((row) => ({
      id: Number(row.id),
      seq: Number(row.seq),
      titulo: String(row.titulo ?? ""),
      status: String(row.status ?? "pending"),
      resultado: row.resultado ? String(row.resultado) : null,
      deliverCount: Number(row.deliver_count ?? 0),
      workspaceStatus: row.workspace_status ? String(row.workspace_status) : null,
      workspaceBranch: row.workspace_branch ? String(row.workspace_branch) : null,
      workspaceCommitSha: row.workspace_commit_sha ? String(row.workspace_commit_sha) : null,
      correctionForSubtaskId: row.correction_for_subtask_id ? Number(row.correction_for_subtask_id) : null,
    }))

    const { rows: blockRows } = await this.db.query(
      "SELECT b.block_reason, b.block_excerpt, b.blocked_at, b.subtarefa_id " +
      "FROM projeto_640.bloqueios b " +
      "INNER JOIN projeto_640.tarefas t ON t.id = b.tarefa_id " +
      whereTask +
      "ORDER BY b.blocked_at DESC LIMIT 1",
      taskParams,
    )
    const ultimoBloqueio: UltimoBloqueio | null = blockRows.length > 0 ? {
      kind: String(blockRows[0]!.block_reason ?? ""),
      excerpt: String(blockRows[0]!.block_excerpt ?? ""),
      blockedAt: String(blockRows[0]!.blocked_at ?? ""),
      subtaskId: blockRows[0]!.subtarefa_id ? Number(blockRows[0]!.subtarefa_id) : null,
    } : null

    return { ...task, subtasks, errorMessage: data.errorMessage, ultimoBloqueio }
  }

  private mapSaveDataToTask(data: import("../shared/types/infrastructure.js").SaveTaskData): Task {
    return {
      id: data.id, chatId: data.chatId ?? "", agentId: data.agentId ?? "",
      title: data.title, description: data.description ?? "",
      repoPath: data.repoPath ?? "", buildCommand: data.buildCommand ?? "npm run build",
      unitTestCommand: data.unitTestCommand ?? "npm run test", unitTestExclude: [],
      baselineMode: "full", status: data.status as Task["status"],
      maxRework: data.maxRework, hardTimeoutMs: data.hardTimeoutMs,
      dependsOnTaskId: data.dependsOnTaskId, projectSlug: data.projectSlug ?? null,
      createdAt: data.createdAt ?? new Date().toISOString(),
      updatedAt: data.updatedAt ?? new Date().toISOString(),
    }
  }

  async enqueueTask(taskId: string): Promise<{ executionId: string }> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    if (task.status !== "planned" && task.status !== "paused") {
      throw new Error("Tarefa " + taskId + " esta em status " + task.status)
    }
    if (task.status !== "planned") {
      await this.saveTaskTransition(task, "queue")
    }
    await this.pump()
    return { executionId: "exec-" + task.id + "-" + Date.now() }
  }

  async pauseTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    if (task.status !== "running" && task.status !== "analyzing") {
      throw new Error("Tarefa " + taskId + " nao esta em execucao")
    }
    for (const [executionId, worker] of this.activeWorkers.entries()) {
      if (worker.taskId === taskId) {
        await this.workerLauncher.stopWorker(executionId)
        await this.onTaskPaused(executionId, "Pausada via API")
        return
      }
    }
    throw new Error("Worker ativo nao encontrado para tarefa " + taskId)
  }

  async resumeTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    if (task.status !== "paused") throw new Error("Tarefa " + taskId + " nao esta pausada")
    const hasPlan = await this.taskHasPersistedPlan(taskId)
    await this.saveTaskTransition(task, hasPlan ? "resume" : "resume_without_plan")
    await this.pump()
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.repository.getTask(taskId)
    if (!task) throw new Error("Tarefa " + taskId + " nao encontrada")
    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error("Tarefa " + taskId + " ja esta " + task.status)
    }
    for (const [executionId, worker] of this.activeWorkers.entries()) {
      if (worker.taskId === taskId) {
        await this.workerLauncher.stopWorker(executionId)
        if (this.beginFinalization(executionId, worker)) await this.finishWorker(executionId, worker)
        break
      }
    }
    await this.saveTaskTransition(task, "cancel")
    await this.pump()
  }

  private beginFinalization(executionId: string, worker: ActiveWorker): boolean {
    if (this.finalizingExecutions.has(executionId)) return false
    this.finalizingExecutions.add(executionId)
    if (worker.timeoutHandle) {
      clearTimeout(worker.timeoutHandle)
      worker.timeoutHandle = undefined
    }
    if (worker.silenceHandle) {
      clearTimeout(worker.silenceHandle)
      worker.silenceHandle = undefined
    }
    return true
  }

  private armWorkerTimeout(executionId: string, taskTimeoutMs: number): void {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return
    const timeoutMs = this.config.workerTimeoutMs ?? taskTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return

    worker.timeoutHandle = setTimeout(() => {
      void this.handleWorkerFailure(
        executionId,
        `Worker excedeu o timeout de ${timeoutMs}ms`,
        "timeout",
      )
    }, timeoutMs)
    this.armSilenceWatchdog(executionId)
  }

  private armSilenceWatchdog(executionId: string): void {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return
    const silenceMs = 600_000 // 10 minutos - tempo suficiente para chamadas LLM demoradas
    worker.lastHeartbeatAt = new Date()
    if (worker.silenceHandle) clearTimeout(worker.silenceHandle)
    worker.silenceHandle = setTimeout(() => {
      void this.handleWorkerFailure(executionId, "Worker sem heartbeat por 600000ms", "lost")
    }, silenceMs)
  }

  private async handleWorkerFailure(executionId: string, reason: string, kind = "worker_failure"): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker || this.finalizingExecutions.has(executionId)) return

    this.logger.warn("Encerrando worker: " + executionId + " - " + reason, { executionId })
    try {
      await this.workerLauncher.stopWorker(executionId, 5000)
    } catch (error) {
      this.logger.error("Falha ao encerrar worker " + executionId + ": " + describeError(error), { executionId })
      this.workerLauncher.killWorker(executionId)
    }
    await this.onTaskFailed(executionId, reason, kind)
  }

  private async finishWorker(executionId: string, worker: ActiveWorker): Promise<void> {
    if (worker.timeoutHandle) {
      clearTimeout(worker.timeoutHandle)
      worker.timeoutHandle = undefined
    }
    try {
      if (worker.workspace && worker.repoPath) {
        await this.workspaceManager.cleanup({ repoPath: worker.repoPath, workspacePath: worker.workspace.path })
        await this.db.query(
          "UPDATE projeto_640.subtarefas SET workspace_cleaned_at = NOW() WHERE id = ?",
          [worker.subtaskId],
        )
      }
    } catch (error) {
      this.logger.error("Falha ao limpar workspace " + executionId + ": " + describeError(error), { executionId, subtaskId: worker.subtaskId })
      if (worker.subtaskId) {
        await this.db.query(
          "UPDATE projeto_640.subtarefas SET workspace_status = 'cleanup_failed', resultado = ? WHERE id = ?",
          [String(error).substring(0, 500), worker.subtaskId],
        ).catch((dbError: unknown) => this.logger.error("Falha ao registrar limpeza: " + describeError(dbError), { executionId, subtaskId: worker.subtaskId }))
      }
    } finally {
      try {
        if (worker.resourceKey) await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
      } finally {
        this.activeWorkers.delete(executionId)
        this.finalizingExecutions.delete(executionId)
        await this.pump()
      }
    }
  }

  private setupEventHandlers(): void {
    this.workerLauncher.on("completed", async (msg: { executionId: string; result: ExecutionResult }) => {
      await this.onTaskCompleted(msg.executionId, msg.result)
    })
    this.workerLauncher.on("failed", async (msg: { executionId: string; error: string }) => {
      await this.onTaskFailed(msg.executionId, msg.error)
    })
    this.workerLauncher.on("heartbeat", (msg: { executionId: string }) => {
      const worker = this.activeWorkers.get(msg.executionId)
      if (!worker) return
      worker.lastHeartbeatAt = new Date()
      this.armSilenceWatchdog(msg.executionId)
      this.publishActivity(worker, { type: "heartbeat" })
      if (!worker.resourceKey) return
      void this.resourceLease.renew(worker.resourceKey, msg.executionId, worker.fencingToken).then((result) => {
        if (result.kind === "lost") {
          this.logger.warn("Lease perdido: " + msg.executionId + " - " + result.reason, { executionId: msg.executionId })
          void this.handleWorkerFailure(msg.executionId, "Lease perdido: " + result.reason, "lease_lost")
        }
      }).catch((error: unknown) => {
        this.logger.error("Falha ao renovar lease: " + msg.executionId + ": " + describeError(error), { executionId: msg.executionId })
      })
    })
    this.workerLauncher.on("worker_exit", (event: { executionId: string; code: number | null }) => {
      if (this.activeWorkers.has(event.executionId)) {
        const reason = event.code === 0
          ? "Worker encerrou sem enviar o evento completed"
          : "Worker encerrado inesperadamente (codigo " + String(event.code) + ")"
        this.logger.error(reason + ": " + event.executionId, { executionId: event.executionId })
        void this.onTaskFailed(event.executionId, reason, "worker_exit").catch((error: unknown) => {
          this.logger.error("Falha ao persistir encerramento do worker: " + describeError(error), { executionId: event.executionId })
        })
      }
    })
    this.workerLauncher.on("worker_error", (event: { executionId: string; error: Error }) => {
      const reason = "Erro no worker: " + event.error.message
      this.logger.error(reason + ": " + event.executionId, { executionId: event.executionId })
      void this.onTaskFailed(event.executionId, reason).catch((error: unknown) => {
        this.logger.error("Falha ao persistir erro do worker: " + describeError(error), { executionId: event.executionId })
      })
    })
    this.workerLauncher.on("log", (event: { executionId: string; level: string; message: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "log", level: event.level as "info" | "warn" | "error", message: event.message })
      this.logger.info("[" + event.level.toUpperCase() + "] " + event.message, { executionId: event.executionId })
    })
    this.workerLauncher.on("progress", (event: { executionId: string; phase: string; message: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "progress", executionPhase: event.phase as import("../shared/types/execution.js").ExecutionPhase, message: event.message })
      this.logger.info("[PROGRESS " + event.phase + "] " + event.message, { executionId: event.executionId })
    })
    this.workerLauncher.on("model_unavailable", (event: { executionId: string; model: string; message: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "model_unavailable", level: "warn", model: event.model, message: event.message })
    })
    this.workerLauncher.on("started", (event: { executionId: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "started" })
    })
  }

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: String(row.external_id ?? row.id ?? ""),
      chatId: String(row.chat_id ?? ""),
      agentId: String(row.agent_id ?? ""),
      title: String(row.titulo ?? row.title ?? ""),
      description: String(row.descricao ?? row.description ?? ""),
      repoPath: String(row.repo_path ?? ""),
      buildCommand: String(row.build_command ?? ""), unitTestCommand: String(row.unit_test_command ?? ""),
      unitTestExclude: [], baselineMode: "full",
      status: String(row.status ?? "planned") as Task["status"],
      maxRework: Number(row.max_rework ?? row.default_max_rework ?? 3),
      hardTimeoutMs: Number(row.hard_timeout_ms ?? row.default_hard_timeout_ms ?? 3600000),
      dependsOnTaskId: row.depends_on_task_id ? String(row.depends_on_task_id) : undefined,
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      createdAt: String(row.created_at ?? new Date().toISOString()),
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
    }
  }

  private mapSubtask(row: Record<string, unknown>): SubtaskWithTask {
    return {
      id: Number(row.id),
      seq: Number(row.seq),
      titulo: String(row.titulo ?? ""),
      scope: row.scope ? String(row.scope) : undefined,
      acceptanceCriteria: Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : (typeof row.acceptance_criteria === "string" ? JSON.parse(row.acceptance_criteria) : undefined),
      tarefaId: Number(row.tarefa_id),
      taskExternalId: String(row.task_external_id ?? row.tarefa_id),
      taskTitulo: String(row.task_titulo ?? ""),
      taskDescricao: row.task_descricao ? String(row.task_descricao) : "",
      repoPath: String(row.repo_path ?? ""),
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      branchTrabalho: row.branch_trabalho ? String(row.branch_trabalho) : null,
      agentId: String(row.agent_id ?? ""),
      buildCommand: row.build_command ? String(row.build_command) : null,
      unitTestCommand: row.unit_test_command ? String(row.unit_test_command) : null,
      unitTestExclude: this.parseStringArray(row.unit_test_exclude),
      maxRework: row.task_max_rework === null || row.task_max_rework === undefined ? (row.default_max_rework === null || row.default_max_rework === undefined ? null : Number(row.default_max_rework)) : Number(row.task_max_rework),
      hardTimeoutMs: row.task_hard_timeout_ms === null || row.task_hard_timeout_ms === undefined ? (row.default_hard_timeout_ms === null || row.default_hard_timeout_ms === undefined ? null : Number(row.default_hard_timeout_ms)) : Number(row.task_hard_timeout_ms),
      deliverCount: Number(row.deliver_count ?? 0),
    }
  }

  private assertExecutionConfig(subtask: SubtaskWithTask): asserts subtask is SubtaskWithTask & { buildCommand: string; unitTestCommand: string } {
    const missing = [
      !subtask.repoPath && "repo_path",
      !subtask.branchTrabalho && "branch_trabalho",
      !subtask.buildCommand && "build_command",
      !subtask.unitTestCommand && "unit_test_command",
    ].filter(Boolean)
    if (missing.length > 0) throw new Error("Projeto sem configuração operacional: " + missing.join(", "))
  }

  private parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String)
    if (typeof value !== "string") return []
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }

  private async taskHasPersistedPlan(taskId: string): Promise<boolean> {
    const isNumeric = /^\d+$/.test(taskId)
    const { rows } = await this.db.query(
      isNumeric
        ? "SELECT EXISTS(SELECT 1 FROM projeto_640.subtarefas s INNER JOIN projeto_640.tarefas t ON t.id = s.tarefa_id WHERE t.external_id = ? OR t.id = ?) AS has_plan"
        : "SELECT EXISTS(SELECT 1 FROM projeto_640.subtarefas s INNER JOIN projeto_640.tarefas t ON t.id = s.tarefa_id WHERE t.external_id = ?) AS has_plan",
      isNumeric ? [taskId, taskId] : [taskId],
    )
    return Number(rows[0]?.has_plan ?? 0) === 1
  }

  private async saveTaskTransition(
    task: import("../shared/types/infrastructure.js").SaveTaskData,
    transition: TaskTransition,
    patch: Partial<import("../shared/types/infrastructure.js").SaveTaskData> = {},
  ): Promise<void> {
    const status = transitionTask(task.status as Task["status"], transition)
    await this.repository.saveTask({ ...task, ...patch, status, updatedAt: new Date().toISOString() })
  }

  private publishActivity(worker: ActiveWorker, event: Omit<import("../events/ExecutionEventBus.js").ExecutionActivityEvent, "executionId" | "taskId" | "subtaskId" | "phase" | "timestamp">): void {
    this.eventBus.publish({
      ...event,
      executionId: worker.executionId,
      taskId: worker.taskId,
      subtaskId: worker.subtaskId,
      phase: worker.phase,
      timestamp: new Date(),
    })
  }

  private async promoteOriginalAfterTestOnlyCorrection(subtaskId: number, workspace: { path: string; branch: string; baseCommit: string }, commitSha?: string): Promise<void> {
    if (!commitSha) return
    const { rows } = await this.db.query(
      "SELECT correction_for_subtask_id FROM projeto_640.subtarefas WHERE id = ?",
      [subtaskId],
    )
    const originalId = Number(rows[0]?.correction_for_subtask_id ?? 0)
    if (!originalId) return
    const paths = await this.workspaceManager.changedPaths(workspace.path, workspace.baseCommit, commitSha)
    if (!correctionOnlyChangesTests(paths)) return
    await this.db.query(
      "UPDATE projeto_640.subtarefas SET status = 'verified', resultado = CONCAT(COALESCE(resultado, ''), '\\nCorrigida por subtarefa ', ?), finalizada_em = NOW(), updated_at = NOW() WHERE id = ? AND status = 'rejected'",
      [subtaskId, originalId],
    )
  }

  private async getProjectModelChain(projectSlug: string | null, phase: ModelPhase): Promise<readonly ModelSelection[]> {
    if (!projectSlug) return defaultChain(phase)
    const { rows } = await this.db.query(
      "SELECT pmc.modelo, pmc.posicao, pmc.is_local FROM projeto_640.projeto_model_chain pmc " +
      "INNER JOIN projeto_640.projetos_captados pc ON pc.id = pmc.projeto_id " +
      "WHERE pc.slug = ? AND pmc.fase = ? AND pmc.ativo = 1 ORDER BY pmc.posicao ASC",
      [projectSlug, phase],
    )
    if (rows.length === 0) return defaultChain(phase)
    return rows.map((row) => ({ model: String(row.modelo), position: Number(row.posicao), isLocal: Boolean(row.is_local) }))
  }
}
