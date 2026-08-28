/**
 * TaskCoordinator - Coordenador principal do Motor v2
 */

import type { Db, TaskRepository } from '../shared/types/infrastructure.js'
import type { Task } from '../shared/types/index.js'
import type { ResourceKey } from '../shared/types/resources.js'
import { ResourceLeaseService } from '../resources/ResourceLeaseService.js'
import { RESOURCE_KEYS } from '../shared/types/resources.js'
import { WorkerLauncher } from '../workers/WorkerLauncher.js'

interface ActiveWorker {
  taskId: string
  executionId: string
  resourceKey: ResourceKey | null
  fencingToken: number
  startedAt: Date
}

export interface TaskCoordinatorConfig {
  maxWorkers: number
  maxWorkersPerProject: number
}

const DEFAULT_CONFIG: TaskCoordinatorConfig = {
  maxWorkers: 1,
  maxWorkersPerProject: 1,
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

  /**
   * Tenta iniciar a próxima tarefa elegível
   */
  async pump(): Promise<void> {
    if (this.activeWorkers.size >= this.config.maxWorkers) {
      return
    }

    const task = await this.selectNextTask()
    if (!task) return

    console.log(`[TaskCoordinator] Tarefa selecionada: ${task.id} (${task.title})`)
    await this.startTask(task)
  }

  private async selectNextTask(): Promise<Task | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM projeto_640.tarefas
       WHERE status = 'planned'
       ORDER BY created_at ASC
       LIMIT 1`
    )

    if (rows.length === 0) return null
    return this.mapTask(rows[0]!)
  }

  private async startTask(task: Task): Promise<void> {
    const executionId = `exec-${task.id}-${Date.now()}`
    const resourceKey = task.projectSlug
      ? RESOURCE_KEYS.projectExecution(task.projectSlug)
      : null

    let fencingToken = 0

    if (resourceKey) {
      const acquireResult = await this.resourceLease.acquire(resourceKey, executionId, task.id, 60)

      if (acquireResult.kind === 'waiting') {
        console.log(`[TaskCoordinator] Tarefa ${task.id} aguardando recurso (posição ${acquireResult.position})`)
        await this.repository.saveTask({ ...task, status: 'paused', updatedAt: new Date().toISOString() })
        return
      }

      if (acquireResult.kind === 'denied') {
        console.error(`[TaskCoordinator] Falha ao adquirir recurso:`, acquireResult.reason)
        return
      }

      fencingToken = acquireResult.lease.fencingToken
      console.log(`[TaskCoordinator] Lock adquirido: ${resourceKey} (token: ${fencingToken})`)
    }

    this.activeWorkers.set(executionId, {
      taskId: task.id,
      executionId,
      resourceKey,
      fencingToken,
      startedAt: new Date(),
    })

    try {
      await this.workerLauncher.spawn({
        context: {
          executionId,
          taskId: task.id,
          projectSlug: task.projectSlug,
          phase: 'prepare',
          fencingToken,
          startedAt: new Date(),
        },
        task,
        repoPath: task.repoPath,
        buildCommand: task.buildCommand,
        testCommand: task.unitTestCommand,
      })

      await this.repository.saveTask({
        ...task,
        status: 'running',
        executionId,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      console.log(`[TaskCoordinator] Worker iniciado: ${task.id} (${executionId})`)
    } catch (error) {
      console.error(`[TaskCoordinator] Erro ao iniciar worker:`, error)
      if (resourceKey) {
        await this.resourceLease.release(resourceKey, executionId, fencingToken)
      }
      this.activeWorkers.delete(executionId)
    }
  }

  async onTaskCompleted(executionId: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return

    console.log(`[TaskCoordinator] Tarefa completada: ${worker.taskId}`)
    const task = await this.repository.getTask(worker.taskId)
    if (task) {
      await this.repository.saveTask({ ...task, status: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    }

    if (worker.resourceKey) {
      await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    }

    this.activeWorkers.delete(executionId)
    await this.pump()
  }

  async onTaskFailed(executionId: string, error: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return

    console.error(`[TaskCoordinator] Tarefa falhou: ${worker.taskId}`, error)
    const task = await this.repository.getTask(worker.taskId)
    if (task) {
      await this.repository.saveTask({ ...task, status: 'failed', errorMessage: error, updatedAt: new Date().toISOString() })
    }

    if (worker.resourceKey) {
      await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    }

    this.activeWorkers.delete(executionId)
    await this.pump()
  }

  async onTaskPaused(executionId: string, reason: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) return

    console.log(`[TaskCoordinator] Tarefa pausada: ${worker.taskId} - ${reason}`)
    const task = await this.repository.getTask(worker.taskId)
    if (task) {
      await this.repository.saveTask({ ...task, status: 'paused', updatedAt: new Date().toISOString() })
    }

    if (worker.resourceKey) {
      await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    }

    this.activeWorkers.delete(executionId)
    await this.pump()
  }

  async onResourceReleased(resourceKey: ResourceKey): Promise<void> {
    console.log(`[TaskCoordinator] Recurso liberado: ${resourceKey}`)
    await this.pump()
  }

  getStats() {
    return {
      activeWorkers: this.activeWorkers.size,
      maxWorkers: this.config.maxWorkers,
    }
  }

  private setupEventHandlers(): void {
    this.workerLauncher.on('completed', async (msg: { executionId: string }) => {
      await this.onTaskCompleted(msg.executionId)
    })

    this.workerLauncher.on('failed', async (msg: { executionId: string; error: string }) => {
      await this.onTaskFailed(msg.executionId, msg.error)
    })

    this.workerLauncher.on('worker_exit', (event: { executionId: string; code: number | null }) => {
      if (event.code !== 0) {
        console.warn(`[TaskCoordinator] Worker saiu com código ${event.code}: ${event.executionId}`)
      }
    })
  }

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: String(row.id ?? row.external_id ?? ''),
      chatId: String(row.chat_id ?? ''),
      agentId: String(row.agent_id ?? row.agentId ?? ''),
      title: String(row.title ?? row.titulo ?? ''),
      description: String(row.description ?? row.descricao ?? ''),
      repoPath: String(row.repo_path ?? row.repoPath ?? ''),
      buildCommand: String(row.build_command ?? row.buildCommand ?? 'npm run build'),
      unitTestCommand: String(row.unit_test_command ?? row.unitTestCommand ?? 'npm run test'),
      unitTestExclude: [],
      baselineMode: 'full',
      status: String(row.status ?? 'planned') as Task['status'],
      maxRework: Number(row.max_rework ?? row.maxRework ?? 3),
      hardTimeoutMs: Number(row.hard_timeout_ms ?? row.hardTimeoutMs ?? 3600000),
      dependsOnTaskId: row.depends_on_task_id ? String(row.depends_on_task_id) : undefined,
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      createdAt: String(row.created_at ?? new Date().toISOString()),
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
    }
  }
}
