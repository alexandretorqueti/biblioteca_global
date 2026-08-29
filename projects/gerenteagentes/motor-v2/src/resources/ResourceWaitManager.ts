/**
 * ResourceWaitManager - Gerenciamento de fila de espera por recursos
 */

import type { Db, TaskRepository } from '../shared/types/infrastructure.js'
import type { ResourceKey } from '../shared/types/resources.js'
import type { Task } from '../shared/types/index.js'
import { resourceEventBus } from './ResourceEventBus.js'

export class ResourceWaitManager {
  private db: Db
  private repository: TaskRepository

  constructor(db: Db, repository: TaskRepository) {
    this.db = db
    this.repository = repository
    this.setupEventHandlers()
  }

  private setupEventHandlers(): void {
    resourceEventBus.on('released', async (event) => {
      await this.onResourceReleased(event.resourceKey)
    })
  }

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

  async cancelWait(taskId: string): Promise<void> {
    await this.db.query(
      `DELETE q FROM projeto_640.execution_resource_queue q
       INNER JOIN projeto_640.tarefas t ON t.resource_wait_id = q.id
       WHERE t.id = ? AND q.status = 'waiting'`,
      [taskId]
    )
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
  }

  private async onResourceReleased(resourceKey: ResourceKey): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT t.* 
       FROM projeto_640.tarefas t
       WHERE t.status = 'paused'
         AND t.resource_wait_key = ?
       ORDER BY t.resource_wait_position ASC
       LIMIT 1`,
      [resourceKey]
    )

    if (rows.length === 0) return

    const row = rows[0]!
    const taskId = String(row.id ?? '')

    const { rows: subtaskRows } = await this.db.query(
      `SELECT 1 FROM projeto_640.subtarefas
       WHERE tarefa_id = ? AND status IN ('pending', 'running', 'rejected')
       LIMIT 1`,
      [taskId]
    )
    const resumeStatus = subtaskRows.length > 0 ? 'ready' : 'planned'

    await this.db.transaction(async (tx) => {
      await tx.query(
      `UPDATE projeto_640.tarefas 
       SET status = ?,
           resource_wait_key = NULL,
           resource_wait_id = NULL,
           resource_wait_position = NULL,
           paused_at = NULL
       WHERE id = ?`,
        [resumeStatus, taskId]
      )
      await tx.query(
        `UPDATE projeto_640.execution_resource_queue
         SET status = 'granted'
         WHERE id = ? AND status = 'waiting'`,
        [row.resource_wait_id]
      )
    })

    console.log(`[ResourceWaitManager] Tarefa ${taskId} retomada como ${resumeStatus}`)
  }

  async getWaitingTasks(resourceKey: ResourceKey): Promise<Task[]> {
    const { rows } = await this.db.query(
      `SELECT t.* 
       FROM projeto_640.tarefas t
       WHERE t.status = 'paused'
         AND t.resource_wait_key = ?
       ORDER BY t.resource_wait_position ASC`,
      [resourceKey]
    )

    return rows.map((row: Record<string, unknown>) => this.mapTask(row))
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
