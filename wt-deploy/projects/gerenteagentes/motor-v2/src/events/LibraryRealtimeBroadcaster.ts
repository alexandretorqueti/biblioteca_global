import { randomUUID } from 'node:crypto'
import type { Db } from '../shared/types/infrastructure.js'
import type { ExecutionActivityBroadcaster, ExecutionActivityEvent } from './ExecutionEventBus.js'

interface LibraryRealtimeBroadcasterConfig {
  db: Db
  endpoint: string
  token: string
  fetchImpl?: typeof fetch
}

interface RealtimeIds {
  taskId: number
  projectId: number
  projectSlug: string
}

export class LibraryRealtimeBroadcaster implements ExecutionActivityBroadcaster {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: LibraryRealtimeBroadcasterConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async publish(event: ExecutionActivityEvent): Promise<void> {
    const ids = await this.resolveIds(event.taskId)
    const eventId = randomUUID()
    const response = await this.fetchImpl(this.config.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.token}`,
        'content-type': 'application/json',
        'idempotency-key': eventId,
      },
      body: JSON.stringify({
        eventId,
        occurredAt: event.timestamp.toISOString(),
        source: 'gerenteagentes-motor-v2',
        projectId: ids.projectId,
        taskId: ids.taskId,
        sourceTaskId: event.taskId,
        sourceProjectSlug: ids.projectSlug,
        subtaskId: event.subtaskId,
        type: event.type,
        payload: {
          executionId: event.executionId,
          phase: event.phase,
          ...(event.executionPhase ? { executionPhase: event.executionPhase } : {}),
          ...(event.level ? { level: event.level } : {}),
          ...(event.message ? { message: event.message } : {}),
          ...(event.model ? { model: event.model } : {}),
        },
      }),
    })
    if (!response.ok) throw new Error(`RealtimeGateway recusou evento (${response.status})`)
  }

  private async resolveIds(taskId: string): Promise<RealtimeIds> {
    const numeric = /^\d+$/.test(taskId)
    const { rows } = await this.config.db.query(
      `SELECT t.id AS task_id, pc.id AS project_id, pc.slug AS project_slug
       FROM projeto_640.tarefas t
       INNER JOIN projeto_640.projetos_captados pc ON pc.id = t.projeto_id
       WHERE ${numeric ? '(t.external_id = ? OR t.id = ?)' : 't.external_id = ?'}
       LIMIT 1`,
      numeric ? [taskId, taskId] : [taskId],
    )
    const row = rows[0]
    const resolvedTaskId = Number(row?.task_id ?? 0)
    const projectId = Number(row?.project_id ?? 0)
    const projectSlug = String(row?.project_slug ?? '')
    if (!resolvedTaskId || !projectId || !projectSlug) {
      throw new Error(`Mapeamento realtime não encontrado para taskId=${taskId}`)
    }
    return { taskId: resolvedTaskId, projectId, projectSlug }
  }
}
