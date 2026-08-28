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
import type { SubtaskInfo } from "../shared/types/execution.js"
import { ResourceLeaseService } from "../resources/ResourceLeaseService.js"
import { RESOURCE_KEYS } from "../shared/types/resources.js"
import { WorkerLauncher } from "../workers/WorkerLauncher.js"

interface ActiveWorker {
  taskId: string
  executionId: string
  resourceKey: ResourceKey | null
  fencingToken: number
  startedAt: Date
  phase: "analyze" | "execute"
  subtaskId?: number
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
}

export class TaskCoordinator {
  private config: TaskCoordinatorConfig
  private activeWorkers = new Map<string, ActiveWorker>()
  private resourceLease: ResourceLeaseService
  private workerLauncher: WorkerLauncher
  private db: Db
  private repository: TaskRepository

  constructor(
    db: Db,
    repository: TaskRepository,
    resourceLease: ResourceLeaseService,
    config: Partial<TaskCoordinatorConfig> = {}
  ) {
    this.db = db
    this.repository = repository
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.resourceLease = resourceLease
    this.workerLauncher = new WorkerLauncher()
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
      "SELECT t.*, pc.repo_path, pc.slug as project_slug, pc.branch_trabalho, a.id as agent_id " +
      "FROM projeto_640.tarefas t " +
      "LEFT JOIN projeto_640.projetos_captados pc ON t.projeto_id = pc.id " +
      "LEFT JOIN projeto_640.agentes a ON pc.agente_id = a.id " +
      "WHERE t.status = 'planned' ORDER BY t.created_at ASC LIMIT 1"
    )
    if (rows.length === 0) return null
    return this.mapTask(rows[0]!)
  }

  private async selectNextSubtask(): Promise<SubtaskWithTask | null> {
    const { rows } = await this.db.query(
      "SELECT s.*, t.external_id as task_external_id, t.titulo as task_titulo, t.descricao as task_descricao, " +
      "pc.repo_path, pc.slug as project_slug, pc.branch_trabalho, a.id as agent_id " +
      "FROM projeto_640.subtarefas s " +
      "INNER JOIN projeto_640.tarefas t ON s.tarefa_id = t.id " +
      "LEFT JOIN projeto_640.projetos_captados pc ON t.projeto_id = pc.id " +
      "LEFT JOIN projeto_640.agentes a ON pc.agente_id = a.id " +
      "WHERE s.status = 'pending' AND t.status = 'ready' " +
      "ORDER BY s.seq ASC LIMIT 1"
    )
    if (rows.length === 0) return null
    return this.mapSubtask(rows[0]!)
  }

  private async startTaskAnalysis(task: Task): Promise<void> {
    const executionId = "exec-analyze-" + task.id + "-" + Date.now()
    const resourceKey = task.projectSlug ? RESOURCE_KEYS.projectExecution(task.projectSlug) : null
    let fencingToken = 0

    if (resourceKey) {
      const result = await this.resourceLease.acquire(resourceKey, executionId, task.id, 60)
      if (result.kind !== "acquired") {
        console.log("[TaskCoordinator] Tarefa " + task.id + " aguardando recurso")
        return
      }
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
      if (result.kind !== "acquired") {
        console.log("[TaskCoordinator] Subtarefa #" + subtask.seq + " aguardando recurso")
        return
      }
      fencingToken = result.lease.fencingToken
    }

    this.activeWorkers.set(executionId, {
      taskId: subtask.taskExternalId, executionId, resourceKey, fencingToken,
      startedAt: new Date(), phase: "execute", subtaskId: subtask.id,
    })

    try {
      // Marca subtarefa como running
      await this.db.query("UPDATE projeto_640.subtarefas SET status = 'running', iniciada_em = NOW() WHERE id = ?", [subtask.id])

      const subtaskInfo: SubtaskInfo = {
        id: subtask.id, seq: subtask.seq, titulo: subtask.titulo,
        scope: subtask.scope, acceptanceCriteria: subtask.acceptanceCriteria,
      }

      const task: Task = {
        id: subtask.taskExternalId, chatId: "", agentId: subtask.agentId,
        title: subtask.taskTitulo, description: subtask.taskDescricao,
        repoPath: subtask.repoPath, buildCommand: "npm run build",
        unitTestCommand: "npm run test", unitTestExclude: [],
        baselineMode: "full", status: "running",
        maxRework: 3, hardTimeoutMs: 3600000,
        projectSlug: subtask.projectSlug,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }

      await this.workerLauncher.spawn({
        context: {
          executionId, taskId: subtask.taskExternalId, projectSlug: subtask.projectSlug,
          phase: "execute", fencingToken, startedAt: new Date(),
          subtaskId: String(subtask.id),
        },
        task, repoPath: subtask.repoPath,
        buildCommand: "npm run build", testCommand: "npm run test",
        subtask: subtaskInfo,
        workBranch: subtask.branchTrabalho || "motor-v2/task-" + subtask.taskExternalId,
      })

      console.log("[TaskCoordinator] Worker de execucao iniciado: subtarefa #" + subtask.seq + " (" + executionId + ")")
    } catch (error) {
      console.error("[TaskCoordinator] Erro ao iniciar execucao:", error)
      if (resourceKey) await this.resourceLease.release(resourceKey, executionId, fencingToken)
      this.activeWorkers.delete(executionId)
    }
  }

  async onTaskCompleted(executionId: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return

    if (worker.phase === "analyze") {
      console.log("[TaskCoordinator] Analise completada: " + worker.taskId)
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.repository.saveTask({ ...task, status: "ready", updatedAt: new Date().toISOString() })
      }
    } else {
      console.log("[TaskCoordinator] Execucao completada: subtarefa " + worker.subtaskId)
      
      // Verificar se todas subtarefas da tarefa estao completas
      if (worker.subtaskId) {
        const { rows } = await this.db.query(
          "SELECT COUNT(*) as pending FROM projeto_640.subtarefas WHERE tarefa_id = (SELECT tarefa_id FROM projeto_640.subtarefas WHERE id = ?) AND status != verified",
          [worker.subtaskId]
        )
        const pending = (rows[0] as Record<string, unknown>)?.pending as number
        if (pending === 0) {
          console.log("[TaskCoordinator] Todas subtarefas completas! Marcando tarefa como completed")
          const task = await this.repository.getTask(worker.taskId)
          if (task) {
            await this.repository.saveTask({ ...task, status: "completed", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
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

    console.error("[TaskCoordinator] Falha: " + worker.taskId, error)

    if (worker.phase === "analyze") {
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.repository.saveTask({ ...task, status: "failed", errorMessage: "Analise falhou: " + error, updatedAt: new Date().toISOString() })
      }
    } else {
      // Marcar subtarefa como failed
      if (worker.subtaskId) {
        await this.db.query("UPDATE projeto_640.subtarefas SET status = 'failed', resultado = ? WHERE id = ?", [error.substring(0, 500), worker.subtaskId])
      }
      // Marcar tarefa como failed
      const task = await this.repository.getTask(worker.taskId)
      if (task) {
        await this.repository.saveTask({ ...task, status: "failed", errorMessage: error.substring(0, 500), updatedAt: new Date().toISOString() })
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
        this.workerLauncher.killWorker(executionId)
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
    await this.repository.saveTask({ ...task, status: "planned", updatedAt: new Date().toISOString() })
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
        this.workerLauncher.killWorker(executionId)
        this.activeWorkers.delete(executionId)
        if (worker.resourceKey) await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
        break
      }
    }
    await this.repository.saveTask({ ...task, status: "cancelled", updatedAt: new Date().toISOString() })
    await this.pump()
  }

  private setupEventHandlers(): void {
    this.workerLauncher.on("completed", async (msg: { executionId: string }) => {
      await this.onTaskCompleted(msg.executionId)
    })
    this.workerLauncher.on("failed", async (msg: { executionId: string; error: string }) => {
      await this.onTaskFailed(msg.executionId, msg.error)
    })
    this.workerLauncher.on("worker_exit", (event: { executionId: string; code: number | null }) => {
      if (event.code !== 0) console.warn("[TaskCoordinator] Worker saiu com codigo " + event.code + ": " + event.executionId)
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
      buildCommand: "npm run build", unitTestCommand: "npm run test",
      unitTestExclude: [], baselineMode: "full",
      status: String(row.status ?? "planned") as Task["status"],
      maxRework: Number(row.max_rework ?? 3),
      hardTimeoutMs: Number(row.hard_timeout_ms ?? 3600000),
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
      acceptanceCriteria: row.acceptance_criteria ? JSON.parse(String(row.acceptance_criteria)) : undefined,
      tarefaId: Number(row.tarefa_id),
      taskExternalId: String(row.task_external_id ?? row.tarefa_id),
      taskTitulo: String(row.task_titulo ?? ""),
      taskDescricao: row.task_descricao ? String(row.task_descricao) : "",
      repoPath: String(row.repo_path ?? ""),
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      branchTrabalho: row.branch_trabalho ? String(row.branch_trabalho) : null,
      agentId: String(row.agent_id ?? ""),
    }
  }
}
