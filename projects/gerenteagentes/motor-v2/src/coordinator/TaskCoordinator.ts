/**
 * TaskCoordinator - Coordenador principal do Motor v2
 * 
 * Responsável por:
 * - Selecionar tarefas elegíveis
 * - Gerenciar workers (até MAX_WORKERS simultâneos)
 * - Coordenar aquisição de recursos
 * - Retomar tarefas pausadas quando recursos são liberados
 */

import type { Db, TaskRepository } from '@gerente-agentes/persistence'
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
  maxWorkers: 1, // Começa com 1, será aumentado para 2 na Etapa 8
  maxWorkersPerProject: 1,
}

export class TaskCoordinator {
  private config: TaskCoordinatorConfig
  private activeWorkers = new Map<string, ActiveWorker>()
  private resourceLease: ResourceLeaseService
  private workerLauncher: WorkerLauncher

  constructor(
    private db: Db,
    private repository: TaskRepository,
    resourceLease: ResourceLeaseService,
    config: Partial<TaskCoordinatorConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.resourceLease = resourceLease
    this.workerLauncher = new WorkerLauncher()
    this.setupEventHandlers()
  }

  /**
   * Tenta iniciar a próxima tarefa elegível
   */
  async pump(): Promise<void> {
    // Verifica se há capacidade para mais workers
    if (this.activeWorkers.size >= this.config.maxWorkers) {
      return
    }

    // Seleciona próxima tarefa elegível
    const task = await this.selectNextTask()
    if (!task) {
      return
    }

    console.log(`[TaskCoordinator] Tarefa selecionada: ${task.id} (${task.title})`)

    // Inicia execução da tarefa
    await this.startTask(task)
  }

  /**
   * Seleciona a próxima tarefa elegível
   */
  private async selectNextTask(): Promise<Task | null> {
    // Busca tarefas elegíveis: planned ou waiting_resource
    const { rows } = await this.db.query(
      `SELECT * FROM projeto_640.tarefas
       WHERE status IN ('planned')
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`
    )

    if (rows.length === 0) {
      return null
    }

    return this.mapTask(rows[0])
  }

  /**
   * Inicia execução de uma tarefa
   */
  private async startTask(task: Task): Promise<void> {
    const executionId = `exec-${task.id}-${Date.now()}`
    const resourceKey = task.projectSlug 
      ? RESOURCE_KEYS.projectExecution(task.projectSlug)
      : null

    // Tenta adquirir lock do projeto
    if (resourceKey) {
      const acquireResult = await this.resourceLease.acquire(
        resourceKey,
        executionId,
        task.id,
        60 // 60 segundos de timeout
      )

      if (acquireResult.kind === 'waiting') {
        console.log(`[TaskCoordinator] Tarefa ${task.id} aguardando recurso ${resourceKey} (posição ${acquireResult.position})`)
        // Marca tarefa como paused (aguardando recurso)
        await this.repository.saveTask({
          ...task,
          status: 'paused',
          updatedAt: new Date().toISOString(),
        })
        return
      }

      if (acquireResult.kind === 'denied') {
        console.error(`[TaskCoordinator] Falha ao adquirir recurso para tarefa ${task.id}:`, acquireResult.reason)
        return
      }

      // Lock adquirido com sucesso
      console.log(`[TaskCoordinator] Lock adquirido para ${resourceKey} (fencing: ${acquireResult.lease.fencingToken})`)

      // Registra worker ativo
      this.activeWorkers.set(executionId, {
        taskId: task.id,
        executionId,
        resourceKey,
        fencingToken: acquireResult.lease.fencingToken,
        startedAt: new Date(),
      })

      // Spawna worker
      try {
        await this.workerLauncher.spawn({
          context: {
            executionId,
            taskId: task.id,
            projectSlug: task.projectSlug,
            phase: 'prepare',
            fencingToken: acquireResult.lease.fencingToken,
            startedAt: new Date(),
          },
          repoPath: task.repoPath,
          taskTitle: task.title,
          taskDescription: task.description,
          buildCommand: task.buildCommand,
          testCommand: task.unitTestCommand,
        })

        // Atualiza status da tarefa
        await this.repository.saveTask({
          ...task,
          status: 'running',
          executionId,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })

        console.log(`[TaskCoordinator] Worker iniciado para tarefa ${task.id} (exec: ${executionId})`)
      } catch (error) {
        console.error(`[TaskCoordinator] Erro ao iniciar worker para tarefa ${task.id}:`, error)
        
        // Libera lock
        await this.resourceLease.release(resourceKey, executionId, acquireResult.lease.fencingToken)
        
        // Remove worker ativo
        this.activeWorkers.delete(executionId)
      }
    } else {
      // Tarefa sem projeto (não deveria acontecer, mas trata)
      console.warn(`[TaskCoordinator] Tarefa ${task.id} sem projectSlug, executando sem lock`)
      
      this.activeWorkers.set(executionId, {
        taskId: task.id,
        executionId,
        resourceKey: null,
        fencingToken: 0,
        startedAt: new Date(),
      })

      try {
        await this.workerLauncher.spawn({
          context: {
            executionId,
            taskId: task.id,
            projectSlug: task.projectSlug,
            phase: 'prepare',
            fencingToken: 0,
            startedAt: new Date(),
          },
          repoPath: task.repoPath,
          taskTitle: task.title,
          taskDescription: task.description,
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
      } catch (error) {
        console.error(`[TaskCoordinator] Erro ao iniciar worker para tarefa ${task.id}:`, error)
        this.activeWorkers.delete(executionId)
      }
    }
  }

  /**
   * Chamado quando uma tarefa é completada com sucesso
   */
  async onTaskCompleted(executionId: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) {
      console.warn(`[TaskCoordinator] onTaskCompleted chamado para execução desconhecida: ${executionId}`)
      return
    }

    console.log(`[TaskCoordinator] Tarefa completada: ${worker.taskId} (exec: ${executionId})`)

    // Atualiza status da tarefa
    const task = await this.repository.getTask(worker.taskId)
    if (task) {
      await this.repository.saveTask({
        ...task,
        status: 'completed',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }

    // Libera lock
    if (worker.resourceKey) {
      await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    }

    // Remove da lista de workers ativos
    this.activeWorkers.delete(executionId)

    // Tenta próxima tarefa
    await this.pump()
  }

  /**
   * Chamado quando uma tarefa falha
   */
  async onTaskFailed(executionId: string, error: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) {
      console.warn(`[TaskCoordinator] onTaskFailed chamado para execução desconhecida: ${executionId}`)
      return
    }

    console.error(`[TaskCoordinator] Tarefa falhou: ${worker.taskId}`, error)

    // Marca tarefa como failed
    const task = await this.repository.getTask(worker.taskId)
    if (task) {
      await this.repository.saveTask({
        ...task,
        status: 'failed',
        errorMessage: error,
        updatedAt: new Date().toISOString(),
      })
    }

    // Libera lock
    if (worker.resourceKey) {
      await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    }

    // Remove da lista de workers ativos
    this.activeWorkers.delete(executionId)

    // Tenta próxima tarefa
    await this.pump()
  }

  /**
   * Chamado quando uma tarefa é pausada
   */
  async onTaskPaused(executionId: string, reason: string): Promise<void> {
    const worker = this.activeWorkers.get(executionId)
    if (!worker) {
      console.warn(`[TaskCoordinator] onTaskPaused chamado para execução desconhecida: ${executionId}`)
      return
    }

    console.log(`[TaskCoordinator] Tarefa pausada: ${worker.taskId} - ${reason}`)

    // Atualiza status da tarefa
    const task = await this.repository.getTask(worker.taskId)
    if (task) {
      await this.repository.saveTask({
        ...task,
        status: 'paused',
        pauseReason: reason,
        updatedAt: new Date().toISOString(),
      })
    }

    // Libera lock (se tiver)
    if (worker.resourceKey) {
      await this.resourceLease.release(worker.resourceKey, executionId, worker.fencingToken)
    }

    // Remove da lista de workers ativos
    this.activeWorkers.delete(executionId)

    // Tenta próxima tarefa
    await this.pump()
  }

  /**
   * Chamado quando um recurso é liberado (para retomar tarefas pausadas)
   */
  async onResourceReleased(resourceKey: ResourceKey): Promise<void> {
    console.log(`[TaskCoordinator] Recurso liberado: ${resourceKey}, tentando retomar tarefas`)

    // Busca tarefas pausadas aguardando este recurso
    const { rows } = await this.db.query(
      `SELECT * FROM projeto_640.tarefas
       WHERE status = 'paused'
         AND resource_wait_key = ?
       ORDER BY resource_wait_position ASC
       LIMIT 1`,
      [resourceKey]
    )

    if (rows.length === 0) {
      return
    }

    const task = this.mapTask(rows[0])
    console.log(`[TaskCoordinator] Retomando tarefa ${task.id} (aguardava ${resourceKey})`)

    // Limpa estado de espera
    await this.db.query(
      `UPDATE projeto_640.tarefas
       SET status = 'planned',
           resource_wait_key = NULL,
           resource_wait_position = NULL,
           paused_at = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [task.id]
    )

    // Tenta iniciar tarefa
    await this.pump()
  }

  /**
   * Obtém estatísticas do coordenador
   */
  getStats() {
    return {
      activeWorkers: this.activeWorkers.size,
      maxWorkers: this.config.maxWorkers,
    }
  }

  /**
   * Configura handlers de eventos do worker launcher
   */
  private setupEventHandlers(): void {
    this.workerLauncher.on('completed', async (msg) => {
      await this.onTaskCompleted(msg.executionId)
    })

    this.workerLauncher.on('failed', async (msg) => {
      await this.onTaskFailed(msg.executionId, msg.error)
    })

    this.workerLauncher.on('worker_exit', (event) => {
      if (event.code !== 0) {
        console.warn(`[TaskCoordinator] Worker saiu com código ${event.code}: ${event.executionId}`)
      }
    })
  }

  /**
   * Mapeia row do banco para Task
   */
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
