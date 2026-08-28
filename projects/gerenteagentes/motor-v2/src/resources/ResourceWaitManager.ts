/**
 * ResourceWaitManager - Gerenciamento de fila de espera por recursos
 * 
 * Responsável por:
 * - Registrar tarefas aguardando recursos
 * - Retomar tarefas quando recursos são liberados
 * - Cancelar esperas quando necessário
 */

import type { Db, TaskRepository } from '@gerente-agentes/persistence'
import type { ResourceKey } from '../shared/types/resources.js'
import type { Task } from '../shared/types/index.js'
import { resourceEventBus } from './ResourceEventBus.js'

export class ResourceWaitManager {
  constructor(
    private db: Db,
    private repository: TaskRepository
  ) {
    this.setupEventHandlers()
  }

  /**
   * Configura handlers para eventos de recursos
   */
  private setupEventHandlers(): void {
    resourceEventBus.on('released', async (event) => {
      await this.onResourceReleased(event.resourceKey)
    })
  }

  /**
   * Registra tarefa como aguardando recurso
   */
  async waitForResource(
    taskId: string,
    resourceKey: ResourceKey,
    waitId: number,
    position: number
  ): Promise<void> {
    await this.db.query(
      `UPDATE projeto_640.tarefas 
       SET status = 'paused',
           resource_wait_key = ?,
           resource_wait_id = ?,
           resource_wait_position = ?,
           paused_at = NOW()
       WHERE id = ?`,
      [resourceKey, waitId, position, taskId]
    )

    console.log(`[ResourceWaitManager] Tarefa ${taskId} aguardando ${resourceKey} (posição ${position})`)
  }

  /**
   * Cancela espera de uma tarefa
   */
  async cancelWait(taskId: string): Promise<void> {
    await this.db.query(
      `UPDATE projeto_640.tarefas 
       SET status = 'planned',
           resource_wait_key = NULL,
           resource_wait_id = NULL,
           resource_wait_position = NULL,
           paused_at = NULL
       WHERE id = ?`,
      [taskId]
    )

    console.log(`[ResourceWaitManager] Espera cancelada para tarefa ${taskId}`)
  }

  /**
   * Handler para quando um recurso é liberado
   */
  private async onResourceReleased(resourceKey: ResourceKey): Promise<void> {
    // Busca tarefas aguardando este recurso
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
    console.log(`[ResourceWaitManager] Recurso ${resourceKey} liberado, retomando tarefa ${task.id}`)

    // Retoma tarefa
    await this.resumeTask(task)
  }

  /**
   * Retoma uma tarefa pausada
   */
  private async resumeTask(task: Task): Promise<void> {
    // Limpa estado de espera
    await this.db.query(
      `UPDATE projeto_640.tarefas 
       SET status = 'planned',
           resource_wait_key = NULL,
           resource_wait_id = NULL,
           resource_wait_position = NULL,
           paused_at = NULL
       WHERE id = ?`,
      [task.id]
    )

    console.log(`[ResourceWaitManager] Tarefa ${task.id} retomada`)

    // TODO: Notificar TaskCoordinator para tentar pump
    // Por enquanto, apenas atualiza status
  }

  /**
   * Obtém tarefas aguardando um recurso específico
   */
  async getWaitingTasks(resourceKey: ResourceKey): Promise<Task[]> {
    const { rows } = await this.db.query(
      `SELECT t.* 
       FROM projeto_640.tarefas t
       WHERE t.status = 'paused'
         AND t.resource_wait_key = ?
       ORDER BY t.resource_wait_position ASC`,
      [resourceKey]
    )

    return rows.map((row) => this.mapTask(row))
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
