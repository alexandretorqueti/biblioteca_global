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
import type { ExecutionContext } from '../shared/types/execution.js'
import type { ResourceKey } from '../shared/types/resources.js'
import { ResourceLeaseService } from '../resources/ResourceLeaseService.js'
import { RESOURCE_KEYS } from '../shared/types/resources.js'
import { createExecutionContext } from '../shared/types/execution.js'

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
  private activeWorkers = new Map<string, ExecutionContext>()
  private resourceLease: ResourceLeaseService

  constructor(
    private db: Db,
    private repository: TaskRepository,
    resourceLease: ResourceLeaseService,
    config: Partial<TaskCoordinatorConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.resourceLease = resourceLease
  }

  /**
   * Tenta iniciar a próxima tarefa elegível
   */
  async pump(): Promise<void> {
    // Verifica se há capacidade para mais workers
    if (this.activeWorkers.size >= this.config.maxWorkers) {
      return
    }

    // Seleciona próxima tarefa
    const task = await this.selectNextTask()
    if (!task) {
      return
    }

    // Inicia execução
    await this.startTask(task)
  }

  /**
   * Seleciona a próxima tarefa elegível
   */
  private async selectNextTask(): Promise<Task | null> {
    // Busca tarefas planejadas
    const { rows } = await this.db.query(
      `SELECT t.* 
       FROM projeto_640.tarefas t
       LEFT JOIN projeto_640.tarefas dep ON dep.id = t.depends_on_task_id
       WHERE t.status = 'planned'
         AND t.auto_start = 1
         AND (t.depends_on_task_id IS NULL OR dep.status IN ('completed', 'finalizada', 'deployada'))
       ORDER BY t.created_at ASC, t.id ASC
       LIMIT 10`,
      []
    )

    for (const row of rows) {
      const task = this.mapTask(row)
      
      // Verifica se o projeto já tem workers ativos
      const projectResource = RESOURCE_KEYS.projectExecution(task.projectSlug ?? task.agentId)
      const isAvailable = await this.resourceLease.isAvailable(projectResource as ResourceKey)
      
      if (isAvailable) {
        return task
      }
    }

    return null
  }

  /**
   * Inicia execução de uma tarefa
   */
  private async startTask(task: Task): Promise<void> {
    const projectSlug = task.projectSlug ?? task.agentId
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    
    // Adquire lock do projeto
    const projectResource = RESOURCE_KEYS.projectExecution(projectSlug)
    const acquireResult = await this.resourceLease.acquire(
      projectResource as ResourceKey,
      executionId,
      task.id
    )

    if (acquireResult.kind === 'waiting') {
      // Tarefa entra em espera
      await this.repository.saveTask({
        ...task,
        status: 'paused',
        executionId,
      })
      return
    }

    if (acquireResult.kind === 'denied') {
      console.warn(`[Coordinator] Não foi possível adquirir lock para ${projectSlug}`)
      return
    }

    // Cria contexto de execução
    const context = createExecutionContext({
      ...task,
      executionId,
      fencingToken: acquireResult.lease.fencingToken,
    })

    // Atualiza status da tarefa
    await this.repository.saveTask({
      ...task,
      status: 'running',
      executionId,
      fencingToken: acquireResult.lease.fencingToken,
    })

    // Registra worker ativo
    this.activeWorkers.set(executionId, context)

    console.log(`[Coordinator] Iniciando tarefa ${task.id} (execution: ${executionId})`)

    // TODO: Na Etapa 5, isso vai spawnar um worker
    // Por enquanto, apenas registra
  }

  /**
   * Notifica que uma tarefa foi concluída
   */
  async onTaskCompleted(executionId: string): Promise<void> {
    const context = this.activeWorkers.get(executionId)
    if (!context) {
      console.warn(`[Coordinator] Worker ${executionId} não encontrado`)
      return
    }

    // Libera lock do projeto
    const projectResource = RESOURCE_KEYS.projectExecution(context.projectSlug)
    await this.resourceLease.release(
      projectResource as ResourceKey,
      executionId,
      context.fencingToken
    )

    // Remove worker ativo
    this.activeWorkers.delete(executionId)

    console.log(`[Coordinator] Tarefa concluída (execution: ${executionId})`)

    // Tenta iniciar próxima tarefa
    await this.pump()
  }

  /**
   * Notifica que uma tarefa foi pausada aguardando recurso
   */
  async onTaskPaused(executionId: string, resourceKey: string): Promise<void> {
    const context = this.activeWorkers.get(executionId)
    if (!context) {
      return
    }

    // Libera lock do projeto (outro worker pode usar)
    const projectResource = RESOURCE_KEYS.projectExecution(context.projectSlug)
    await this.resourceLease.release(
      projectResource as ResourceKey,
      executionId,
      context.fencingToken
    )

    // Remove worker ativo
    this.activeWorkers.delete(executionId)

    console.log(`[Coordinator] Tarefa pausada aguardando ${resourceKey} (execution: ${executionId})`)

    // Tenta iniciar próxima tarefa
    await this.pump()
  }

  /**
   * Notifica que um recurso foi liberado
   */
  async onResourceReleased(resourceKey: string): Promise<void> {
    // Busca tarefas pausadas aguardando este recurso
    const { rows } = await this.db.query(
      `SELECT t.* 
       FROM projeto_640.tarefas t
       WHERE t.status = 'paused'
         AND t.resource_wait_key = ?
       ORDER BY t.resource_wait_position ASC
       LIMIT 1`,
      [resourceKey]
    )

    if (rows.length === 0) {
      return
    }

    const task = this.mapTask(rows[0])
    console.log(`[Coordinator] Recurso ${resourceKey} liberado, retomando tarefa ${task.id}`)

    // Retoma tarefa
    await this.resumeTask(task)
  }

  /**
   * Retoma uma tarefa pausada
   */
  private async resumeTask(task: Task): Promise<void> {
    // Limpa estado de espera
    await this.repository.saveTask({
      ...task,
      status: 'planned',
      resourceWaitKey: null,
      resourceWaitId: null,
      resourceWaitPosition: null,
    })

    // Tenta iniciar
    await this.pump()
  }

  /**
   * Obtém estatísticas do coordenador
   */
  getStats(): { activeWorkers: number; maxWorkers: number } {
    return {
      activeWorkers: this.activeWorkers.size,
      maxWorkers: this.config.maxWorkers,
    }
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
      analysisCommit: row.analysis_commit ? String(row.analysis_commit) : undefined,
      executionId: row.execution_id ? String(row.execution_id) : undefined,
      fencingToken: row.fencing_token ? Number(row.fencing_token) : undefined,
      createdAt: String(row.created_at ?? new Date().toISOString()),
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
    }
  }
}
