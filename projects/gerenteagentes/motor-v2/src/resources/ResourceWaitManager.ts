/**
 * ResourceWaitManager - Gerenciamento de fila de espera por recursos
 */

import type { Db, TaskRepository } from '../shared/types/infrastructure.js'
import type { ResourceKey } from '../shared/types/resources.js'
import type { Task } from '../shared/types/index.js'
import { createLogger } from '../shared/logger.js'

export class ResourceWaitManager {
  private logger = createLogger('ResourceWaitManager')
  private db: Db
  private repository: TaskRepository

  constructor(db: Db, repository: TaskRepository) {
    this.db = db
    this.repository = repository
  }

  async waitForResource(
    taskId: string,
    resourceKey: ResourceKey,
    waitId: number,
    position: number
  ): Promise<void> {
    const taskWhere = this.taskWhere(taskId)
    await this.db.query(
      `UPDATE projeto_640.tarefas 
       SET status = 'paused',
           resource_wait_key = ?,
           resource_wait_id = ?,
           resource_wait_position = ?,
           paused_at = NOW()
       WHERE ${taskWhere.clause}`,
      [resourceKey, waitId, position, ...taskWhere.params]
    )

    this.logger.info(`Tarefa ${taskId} aguardando ${resourceKey} (posição ${position})`, { taskId })
  }

  async cancelWait(taskId: string): Promise<void> {
    const taskWhere = this.taskWhere(taskId)
    await this.db.query(
      `DELETE q FROM projeto_640.execution_resource_queue q
       INNER JOIN projeto_640.tarefas t ON t.resource_wait_id = q.id
       WHERE ${taskWhere.clause === 'id = ?' ? 't.id = ?' : 't.external_id = ?'} AND q.status = 'waiting'`,
      taskWhere.params
    )
    await this.db.query(
      `UPDATE projeto_640.tarefas 
       SET status = 'planned',
           resource_wait_key = NULL,
           resource_wait_id = NULL,
           resource_wait_position = NULL,
           paused_at = NULL
       WHERE ${taskWhere.clause}`,
      taskWhere.params
    )
  }

  /**
   * Libera, de forma idempotente, somente a próxima tarefa que aguarda este
   * recurso. O coordenador é o único consumidor do evento de release e chama
   * este método antes de voltar a bombear a fila.
   */
  async resumeNext(resourceKey: ResourceKey): Promise<void> {
    const resumedTask = await this.db.transaction(async (tx) => {
      // FOR UPDATE faz com que duas liberações concorrentes não concedam a
      // mesma posição. A seleção e a troca de estado precisam ser uma única
      // transação, pois o event bus pode entregar releases quase simultâneos.
      const { rows } = await tx.query(
        `SELECT t.id, t.resource_wait_id
         FROM projeto_640.tarefas t
         INNER JOIN projeto_640.execution_resource_queue q ON q.id = t.resource_wait_id
         WHERE t.status = 'paused'
           AND t.resource_wait_key = ?
           AND q.status = 'waiting'
         ORDER BY t.resource_wait_position ASC, q.requested_at ASC
         LIMIT 1
         FOR UPDATE`,
        [resourceKey],
      )
      if (rows.length === 0) return null

      const row = rows[0]!
      const taskId = String(row.id ?? '')
      const { rows: subtaskRows } = await tx.query(
        `SELECT 1 FROM projeto_640.subtarefas
         WHERE tarefa_id = ? AND status IN ('pending', 'running', 'rejected')
         LIMIT 1`,
        [taskId],
      )
      const resumeStatus = subtaskRows.length > 0 ? 'ready' : 'planned'

      await tx.query(
        `UPDATE projeto_640.tarefas
         SET status = ?,
             resource_wait_key = NULL,
             resource_wait_id = NULL,
             resource_wait_position = NULL,
             paused_at = NULL
         WHERE id = ? AND status = 'paused' AND resource_wait_id = ?`,
        [resumeStatus, taskId, row.resource_wait_id],
      )
      await tx.query(
        `UPDATE projeto_640.execution_resource_queue
         SET status = 'granted'
         WHERE id = ? AND status = 'waiting'`,
        [row.resource_wait_id]
      )
      return { taskId, resumeStatus }
    })
    if (resumedTask) {
      this.logger.info(`Tarefa ${resumedTask.taskId} retomada como ${resumedTask.resumeStatus}`, { taskId: resumedTask.taskId })
    }
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

  /**
   * A API do motor usa external_id (ex.: task-biblioteca-740), enquanto as
   * colunas de relacionamento da fila usam o id numérico interno. Escolher a
   * coluna antes de bindar o parâmetro evita que o MySQL tente converter um
   * external_id textual para DOUBLE.
   */
  private taskWhere(taskId: string): { clause: 'id = ?' | 'external_id = ?'; params: [string] } {
    return /^\d+$/.test(taskId)
      ? { clause: 'id = ?', params: [taskId] }
      : { clause: 'external_id = ?', params: [taskId] }
  }
}
