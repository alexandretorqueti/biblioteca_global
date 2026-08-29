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

interface ActiveWorker {
  taskId: string
  executionId: string
  resourceKey: ResourceKey | null
  fencingToken: number
  startedAt: Date
  phase: "analyze" | "execute"
  subtaskId?: number
  workspace?: { path: string; branch: string; baseCommit: string }
}

export interface TaskCoordinatorConfig {
  maxWorkers: number
  maxWorkersPerProject: number
}

const DEFAULT_CONFIG: TaskCoordinatorConfig = {
  maxWorkers: 1,
  maxWorkersPerProject: 1,
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
    if (this.activeWorkers.size >= this.config.maxWorkers) return

    // 1. Tenta pegar subtarefa pendente (execucao)
    const subtask = await this.selectNextSubtask()
    if (subtask) {
      console.log("[TaskCoordinator] Subtarefa selecionada: #" + subtask.seq + " " + subtask.titulo)
      await this.startSubtaskExecution(subtask)
      return
    }

    // 2. Se nao tem subtarefa, pega tarefa planejada (analise)
    const task = await this.selectNextTask()
    if (task) {
      console.log("[TaskCoordinator] Tarefa selecionada para analise: " + task.id + " (" + task.title + ")")
      await this.startTaskAnalysis(task)
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

  private async startTaskAnalysis(task: Task): Promise<void> {
    const executionId = "exec-analyze-" + task.id + "-" + Date.now()
    const resourceKey = task.projectSlug ? RESOURCE_KEYS.projectExecution(task.projectSlug) : null
    let fencingToken = 0

    if (resourceKey) {
      const result = await this.resourceLease.acquire(resourceKey, executionId, task.id, 60)
      if (result.kind === "waiting") {
        await this.waitManager?.waitForResource(task.id, resourceKey, result.waitId, result.position)
        console.log("[TaskCoordinator] Tarefa " + task.id + " aguardando recurso")
        return
      }
      if (result.kind !== "acquired") throw new Error("Falha ao adquirir recurso: " + result.reason)
      fencingToken = result.lease.fencingToken
    }

    this.activeWorkers.set(executionId, {
      taskId: task.id, executionId, resourceKey, fencingToken,
      startedAt: new Date(), phase: "analyze",
    })

    try {
      await this.repository.saveTask({ ...task, status: "analyzing", executionId, updatedAt: new Date().toISOString() })

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

      console.log("[TaskCoordinator] Worker de analise iniciado: " + task.id + " (" + executionId + ")")
    } catch (error) {
      console.error("[TaskCoordinator] Erro ao iniciar analise:", error)
      if (resourceKey) await this.resourceLease.release(resourceKey, executionId, fencingToken)
      this.activeWorkers.delete(executionId)
    }
  }

  private async startSubtaskExecution(subtask: SubtaskWithTask): Promise<void> {
    const executionId = "exec-execute-" + subtask.id + "-" + Date.now()
    const resourceKey = subtask.projectSlug ? RESOURCE_KEYS.projectExecution(subtask.projectSlug) : null
    let fencingToken = 0

    if (resourceKey) {
      const result = await this.resourceLease.acquire(resourceKey, executionId, String(subtask.tarefaId), 120)
      if (result.kind === "waiting") {
        await this.waitManager?.waitForResource(String(subtask.tarefaId), resourceKey, result.waitId, result.position)
        console.log("[TaskCoordinator] Subtarefa #" + subtask.seq + " aguardando recurso")
        return
      }
      if (result.kind !== "acquired") throw new Error("Falha ao adquirir recurso: " + result.reason)
      fencingToken = result.lease.fencingToken
    }

    this.activeWorkers.set(executionId, {
      taskId: subtask.taskExternalId, executionId, resourceKey, fencingToken,
      startedAt: new Date(), phase: "execute", subtaskId: subtask.id,
    })

    try {
      if (!subtask.agentId) throw new Error("Projeto sem agente configurado")
      this.assertExecutionConfig(subtask)
      // Marca subtarefa como running
      await this.db.query("UPDATE projeto_640.subtarefas SET status = 'running', iniciada_em = NOW() WHERE id = ?", [subtask.id])
      const parentTask = await this.repository.getTask(subtask.taskExternalId)
      if (parentTask) {
        await this.repository.saveTask({ ...parentTask, status: "running", updatedAt: new Date().toISOString() })
      }
      const baseBranch = subtask.branchTrabalho || "base-desenvolvimento"
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

      console.log("[TaskCoordinator] Worker de execucao iniciado: subtarefa #" + subtask.seq + " (" + executionId + ")")
    } catch (error) {
      console.error("[TaskCoordinator] Erro ao iniciar execucao:", error)
      if (resourceKey) await this.resourceLease.release(resourceKey, executionId, fencingToken)
      this.activeWorkers.delete(executionId)
    }
  }

  async onTaskCompleted(executionId: string, result?: ExecutionResult): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return
    this.publishActivity(worker, { type: "completed" })

    if (worker.phase === "analyze") {
      console.log("[TaskCoordinator] Analise completada: " + worker.taskId)
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.repository.saveTask({ ...task, status: "ready", updatedAt: new Date().toISOString() })
      }
    } else {
      console.log("[TaskCoordinator] Execucao completada: subtarefa " + worker.subtaskId)
      if (worker.subtaskId && worker.workspace) {
        await this.db.query(
          "UPDATE projeto_640.subtarefas SET workspace_commit_sha = ?, workspace_status = 'approved' WHERE id = ?",
          [result?.gitCommitSha ?? null, worker.subtaskId],
        )
        await this.promoteOriginalAfterTestOnlyCorrection(worker.subtaskId, worker.workspace, result?.gitCommitSha)
      }
      
      // Verificar se todas subtarefas da tarefa estao completas
      if (worker.subtaskId) {
        const { rows } = await this.db.query(
          "SELECT COUNT(*) as pending FROM projeto_640.subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AND status != 'verified'",
          [worker.subtaskId]
        )
        const pending = (rows[0] as Record<string, unknown>)?.pending as number
        if (pending === 0) {
          console.log("[TaskCoordinator] Todas subtarefas completas! Marcando tarefa como completed")
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            await this.repository.saveTask({ ...task, status: "completed", updatedAt: new Date().toISOString() })
          }
        } else {
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            await this.repository.saveTask({ ...task, status: "ready", updatedAt: new Date().toISOString() })
          }
        }
      }
    }

    if (worker.resourceKey) await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    this.activeWorkers.delete(executionId)
    await this.pump()
  }

  async onTaskFailed(executionId: string, error: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return
    this.publishActivity(worker, { type: "failed", level: "error", message: error })

    console.error("[TaskCoordinator] Falha: " + worker.taskId, error)

    if (worker.phase === "analyze") {
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.repository.saveTask({ ...task, status: "blocked", errorMessage: "Analise falhou: " + error, updatedAt: new Date().toISOString() })
      }
    } else {
      // Marcar subtarefa como failed
      if (worker.subtaskId) {
        await this.db.query("UPDATE projeto_640.subtarefas SET status = 'blocked', resultado = ? WHERE id = ?", [error.substring(0, 500), worker.subtaskId])
      }
      // Marcar tarefa como failed
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.repository.saveTask({ ...task, status: "blocked", errorMessage: error.substring(0, 500), updatedAt: new Date().toISOString() })
      }
    }

    if (worker.resourceKey) await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    this.activeWorkers.delete(executionId)
    await this.pump()
  }

  async onTaskPaused(executionId: string, reason: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return
    console.log("[TaskCoordinator] Tarefa pausada: " + worker.taskId + " - " + reason)
    const task = await this.repository.getTask(worker.taskId)
    if (task) await this.repository.saveTask({ ...task, status: "paused", updatedAt: new Date().toISOString() })
    if (worker.resourceKey) await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    this.activeWorkers.delete(executionId)
    await this.pump()
  }

  async onResourceReleased(resourceKey: ResourceKey): Promise<void> {
    console.log("[TaskCoordinator] Recurso liberado: " + resourceKey)
    await this.waitManager?.resumeNext(resourceKey)
    await this.pump()
  }

  getStats() {
    return { activeWorkers: this.activeWorkers.size, maxWorkers: this.config.maxWorkers }
  }

  async getTask(taskId: string): Promise<Task | null> {
    const data = await this.repository.getTask(taskId)
    if (!data) return null
    return this.mapSaveDataToTask(data)
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
      await this.repository.saveTask({ ...task, status: "planned", updatedAt: new Date().toISOString() })
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
    await this.repository.saveTask({ ...task, status: hasPlan ? "ready" : "planned", updatedAt: new Date().toISOString() })
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
        this.activeWorkers.delete(executionId)
        if (worker.resourceKey) await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
        break
      }
    }
    await this.repository.saveTask({ ...task, status: "cancelled", updatedAt: new Date().toISOString() })
    await this.pump()
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
      this.publishActivity(worker, { type: "heartbeat" })
      if (!worker.resourceKey) return
      void this.resourceLease.renew(worker.resourceKey, msg.executionId, worker.fencingToken).then((result) => {
        if (result.kind === "lost") {
          console.warn("[TaskCoordinator] Lease perdido: " + msg.executionId + " - " + result.reason)
        }
      }).catch((error: unknown) => {
        console.error("[TaskCoordinator] Falha ao renovar lease: " + msg.executionId, error)
      })
    })
    this.workerLauncher.on("worker_exit", (event: { executionId: string; code: number | null }) => {
      if (event.code !== 0) {
        const reason = "Worker encerrado inesperadamente (codigo " + String(event.code) + ")"
        console.error("[TaskCoordinator] " + reason + ": " + event.executionId)
        void this.onTaskFailed(event.executionId, reason).catch((error: unknown) => {
          console.error("[TaskCoordinator] Falha ao persistir encerramento do worker:", error)
        })
      }
    })
    this.workerLauncher.on("worker_error", (event: { executionId: string; error: Error }) => {
      const reason = "Erro no worker: " + event.error.message
      console.error("[TaskCoordinator] " + reason + ": " + event.executionId)
      void this.onTaskFailed(event.executionId, reason).catch((error: unknown) => {
        console.error("[TaskCoordinator] Falha ao persistir erro do worker:", error)
      })
    })
    this.workerLauncher.on("log", (event: { executionId: string; level: string; message: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "log", level: event.level as "info" | "warn" | "error", message: event.message })
      console.log("[MotorExecution " + event.executionId + "] [" + event.level.toUpperCase() + "] " + event.message)
    })
    this.workerLauncher.on("progress", (event: { executionId: string; phase: string; message: string }) => {
      const worker = this.activeWorkers.get(event.executionId)
      if (worker) this.publishActivity(worker, { type: "progress", executionPhase: event.phase as import("../shared/types/execution.js").ExecutionPhase, message: event.message })
      console.log("[MotorExecution " + event.executionId + "] [PROGRESS " + event.phase + "] " + event.message)
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
      maxRework: row.max_rework === null || row.max_rework === undefined ? (row.default_max_rework === null || row.default_max_rework === undefined ? null : Number(row.default_max_rework)) : Number(row.max_rework),
      hardTimeoutMs: row.hard_timeout_ms === null || row.hard_timeout_ms === undefined ? (row.default_hard_timeout_ms === null || row.default_hard_timeout_ms === undefined ? null : Number(row.default_hard_timeout_ms)) : Number(row.hard_timeout_ms),
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
