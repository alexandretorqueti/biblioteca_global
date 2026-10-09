import { randomUUID } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'

type RealtimeMutationType =
  | 'task.created' | 'task.updated' | 'task.deleted' | 'task.status.changed'
  | 'task.counters.updated'
  | 'subtask.created' | 'subtask.updated' | 'subtask.deleted' | 'subtask.status.changed'

interface TaskIdentity extends RowDataPacket {
  task_id: number
  source_task_id: string | null
  project_id: number
  project_slug: string | null
  title: string
}

interface SubtaskState extends RowDataPacket {
  id: number
  seq: number
  titulo: string
  status: string
}

interface CounterRow extends RowDataPacket {
  total: number | string
  pending: number | string
  running: number | string
  completed: number | string
  failed: number | string
}

export interface RealtimeMutationPublisherConfig {
  endpoint?: string
  token?: string
  fetchImpl?: typeof fetch
}

export interface DeletedTaskRealtimeIdentity {
  taskId: number
  projectId: number
  sourceTaskId: string
  projectSlug?: string | null
  title?: string
}

/**
 * Adaptador resiliente do contrato realtime da Biblioteca. Ele é chamado
 * somente depois de commits e nunca propaga falhas de rede ao fluxo do Motor.
 */
export class RealtimeMutationPublisher {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly pool: Pool, private readonly config: RealtimeMutationPublisherConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async publishTask(taskId: number, type: Extract<RealtimeMutationType, `task.${string}`>, payload: Record<string, unknown> = {}): Promise<void> {
    const identity = await this.taskIdentity(taskId)
    if (!identity) return this.warn(`tarefa ${taskId} não encontrada após mutação`)
    await this.send(identity, type, payload)
  }

  async publishDeletedTask(task: DeletedTaskRealtimeIdentity): Promise<void> {
    await this.send({
      task_id: task.taskId, project_id: task.projectId, source_task_id: task.sourceTaskId,
      project_slug: task.projectSlug ?? null, title: task.title ?? '',
    } as TaskIdentity, 'task.deleted', {})
  }

  async publishSubtask(
    taskId: number,
    subtaskId: number,
    type: Extract<RealtimeMutationType, `subtask.${string}`>,
    previousStatus?: string,
  ): Promise<void> {
    const identity = await this.taskIdentity(taskId)
    if (!identity) return this.warn(`tarefa ${taskId} não encontrada após mutação de subtarefa`)
    const [rows] = await this.pool.query<SubtaskState[]>(
      'SELECT id, seq, titulo, status FROM subtarefas WHERE id = ? AND tarefa_id = ? LIMIT 1', [subtaskId, taskId],
    )
    const subtask = rows[0]
    const payload: Record<string, unknown> = {
      id: subtaskId,
      ...(subtask ? { seq: Number(subtask.seq), title: String(subtask.titulo), status: String(subtask.status) } : {}),
      ...(previousStatus ? { previousStatus } : {}),
    }
    await this.send(identity, type, payload, subtaskId)
    await this.publishCounters(identity)
  }

  async publishAnalysisCreated(taskId: number, subtaskIds: number[]): Promise<void> {
    for (const subtaskId of subtaskIds) await this.publishSubtask(taskId, subtaskId, 'subtask.created')
  }

  private async taskIdentity(taskId: number): Promise<TaskIdentity | null> {
    const [rows] = await this.pool.query<TaskIdentity[]>(
      `SELECT t.id AS task_id, t.external_id AS source_task_id, t.projeto_id AS project_id,
              pc.slug AS project_slug, t.titulo AS title
         FROM tarefas t LEFT JOIN projetos_captados pc ON pc.id=t.projeto_id
        WHERE t.id=? LIMIT 1`, [taskId],
    )
    return rows[0] ?? null
  }

  private async publishCounters(identity: TaskIdentity): Promise<void> {
    const [rows] = await this.pool.query<CounterRow[]>(
      `SELECT COUNT(*) AS total,
        SUM(status='pending') AS pending, SUM(status IN ('running','delivered','verifying')) AS running,
        SUM(status IN ('verified','superseded')) AS completed, SUM(status IN ('failed','blocked')) AS failed
       FROM subtarefas WHERE tarefa_id=?`, [identity.task_id],
    )
    const row = rows[0]
    await this.send(identity, 'task.counters.updated', {
      total: Number(row?.total ?? 0), pending: Number(row?.pending ?? 0), running: Number(row?.running ?? 0),
      completed: Number(row?.completed ?? 0), failed: Number(row?.failed ?? 0),
    })
  }

  private async send(identity: TaskIdentity, type: RealtimeMutationType, payload: Record<string, unknown>, subtaskId?: number): Promise<void> {
    const endpoint = this.config.endpoint
    if (!endpoint) return
    const eventId = randomUUID()
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.token ?? ''}`, 'content-type': 'application/json', 'idempotency-key': eventId },
        body: JSON.stringify({
          eventId, occurredAt: new Date().toISOString(), source: 'gerenteagentes-motor-v3',
          projectId: Number(identity.project_id), taskId: Number(identity.task_id),
          sourceTaskId: String(identity.source_task_id ?? identity.task_id),
          ...(identity.project_slug ? { sourceProjectSlug: String(identity.project_slug) } : {}),
          ...(subtaskId ? { subtaskId } : {}), type, payload,
        }),
      })
      if (!response.ok) this.warn(`ingresso recusou ${type} (${response.status})`)
    } catch (error) {
      this.warn(`falha ao publicar ${type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private warn(message: string): void {
    console.warn(`[Motor v3] realtime: ${message}`)
  }
}
