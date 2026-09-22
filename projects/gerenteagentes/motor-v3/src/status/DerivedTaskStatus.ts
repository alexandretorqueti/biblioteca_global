import type { Pool, RowDataPacket } from 'mysql2/promise'

export type DerivedTaskStatus =
  | 'draft' | 'planned' | 'analyzing' | 'awaiting_clarification' | 'awaiting_interaction'
  | 'ready' | 'running' | 'paused' | 'completed' | 'deployed'
  | 'blocked' | 'motor_fix' | 'failed' | 'cancelled'

interface TaskFactsRow extends RowDataPacket {
  id: number
  paused_at: Date | string | null
  resource_wait_key: string | null
  analysis_started_at: Date | string | null
  terminal_status: string | null
  last_clarification_role: string | null
  awaiting_interaction: number | string
  has_active_blocker: number | string
  deploy_succeeded: number | string
  deploy_failed: number | string
}

/**
 * Projeção canônica do estado operacional da tarefa.
 *
 * `queueStatus` descreve a entrega/consumo da mensagem; não substitui este
 * status de negócio. A ordem acompanha o calculador histórico do Motor v2.
 */
export class DerivedTaskStatusResolver {
  constructor(private readonly pool: Pool) {}

  async resolve(taskId: string): Promise<DerivedTaskStatus> {
    const [rows] = await this.pool.query<TaskFactsRow[]>(`
      SELECT
        t.id, t.paused_at, t.resource_wait_key,
        f.analysis_started_at, f.terminal_status,
        (SELECT c.role FROM tarefa_chats c
          WHERE c.tarefa_id = t.id AND c.role IN ('analyst', 'user')
          ORDER BY c.id DESC LIMIT 1) AS last_clarification_role,
        EXISTS(SELECT 1 FROM tarefa_contextos_execucao cix
          WHERE cix.tarefa_id = t.id AND cix.estado = 'awaiting_human') AS awaiting_interaction,
        EXISTS(SELECT 1 FROM bloqueios b
          WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS has_active_blocker,
        EXISTS(SELECT 1 FROM deploy_requests d
          WHERE d.tarefa_id = t.id AND d.status = 'succeeded') AS deploy_succeeded,
        EXISTS(SELECT 1 FROM deploy_requests d
          WHERE d.tarefa_id = t.id AND d.status = 'failed') AS deploy_failed
      FROM tarefas t
      LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
      WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
      LIMIT 1
    `, [taskId, taskId])

    const task = rows[0]
    if (!task) return 'planned'

    const [subtaskRows] = await this.pool.query<RowDataPacket[]>(
      'SELECT status FROM subtarefas WHERE tarefa_id = ?', [task.id],
    )
    const subtaskStatuses = subtaskRows.map(row => String(row.status ?? ''))
    const terminal = String(task.terminal_status ?? '').toLowerCase()
    const hasSubtasks = subtaskStatuses.length > 0
    const allApproved = hasSubtasks && subtaskStatuses.every(status => ['verified', 'superseded'].includes(status))

    if (terminal === 'cancelled' || terminal === 'failed' || terminal === 'motor_fix') return terminal
    if (task.paused_at && !task.resource_wait_key) {
      if (Number(task.deploy_succeeded) === 1) return 'deployed'
      if (allApproved && (Number(task.deploy_failed) === 1 || await this.integrationConfirmed(task.id))) return 'completed'
      if (!hasSubtasks) return 'draft'
      return 'paused'
    }
    if (task.last_clarification_role === 'analyst') return 'awaiting_clarification'
    if (Number(task.awaiting_interaction) === 1) return 'awaiting_interaction'
    // Um bloqueio operacional (inclusive deploy) nunca pode ser escondido
    // pela projeção de integração concluída abaixo.
    if (Number(task.has_active_blocker) === 1) return 'blocked'
    if (subtaskStatuses.includes('failed')) return 'failed'
    if (subtaskStatuses.includes('blocked')) return 'blocked'
    if (task.analysis_started_at && subtaskStatuses.length === 0) return 'analyzing'
    if (subtaskStatuses.some(status => ['running', 'delivered', 'verifying'].includes(status))) return 'running'
    if (Number(task.deploy_succeeded) === 1) return 'deployed'

    if (allApproved && (Number(task.deploy_failed) === 1 || await this.integrationConfirmed(task.id))) return 'completed'
    if (task.paused_at && !task.resource_wait_key) return 'paused'
    return hasSubtasks ? 'ready' : 'planned'
  }

  private async integrationConfirmed(taskId: number): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT integration_confirmed_at FROM task_runtime_facts WHERE tarefa_id = ? LIMIT 1', [taskId],
    )
    return rows[0]?.integration_confirmed_at != null
  }
}
