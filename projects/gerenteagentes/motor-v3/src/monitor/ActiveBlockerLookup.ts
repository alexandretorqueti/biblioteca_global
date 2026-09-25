import type { Pool, RowDataPacket } from 'mysql2/promise'

export interface ActiveBlockerRow extends RowDataPacket {
  id: number
  tarefa_id: number
  subtarefa_id: number | null
  block_reason: string
  block_command: string | null
  block_excerpt: string | null
}

export interface ActiveBlockerFilter {
  /** id específico em `bloqueios` (evento TASK_BLOCKED carrega quando conhecido). */
  blockId?: number | null
  /** Filtra pelo motivo quando não há blockId. */
  blockReason?: string | null
}

/**
 * Localiza o bloqueio ativo (`resolved_at IS NULL`) de uma tarefa.
 *
 * Compartilhado pelo MonitorResolutionConsumer (consumo de TASK_BLOCKED) e
 * pelo wiring de resume no TaskCoordinator (etapa 6: despausar tarefa
 * bloqueada reemite TASK_BLOCKED para o Monitor trabalhar).
 */
export async function loadActiveBlocker(
  pool: Pool,
  taskId: string,
  filter: ActiveBlockerFilter = {},
): Promise<ActiveBlockerRow | null> {
  const numeric = /^\d+$/.test(taskId)
  const where = numeric ? '(t.external_id = ? OR CAST(t.id AS CHAR) = ?)' : 't.external_id = ?'
  const taskParams: unknown[] = numeric ? [taskId, taskId] : [taskId]
  if (filter.blockId != null) {
    const [rows] = await pool.query<ActiveBlockerRow[]>(
      `SELECT b.id, b.tarefa_id, b.subtarefa_id, b.block_reason, b.block_command, b.block_excerpt
         FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id
        WHERE b.id = ? AND b.resolved_at IS NULL AND ${where} LIMIT 1`,
      [filter.blockId, ...taskParams],
    )
    if (rows[0]) return rows[0]
    // blockId já resolvido: segue para busca por motivo (o evento pode ter
    // sido emitido para um bloqueio antigo já tratado).
  }
  const reasonFilter = filter.blockReason ? 'AND b.block_reason = ?' : ''
  const params = filter.blockReason ? [...taskParams, filter.blockReason] : [...taskParams]
  const [rows] = await pool.query<ActiveBlockerRow[]>(
    `SELECT b.id, b.tarefa_id, b.subtarefa_id, b.block_reason, b.block_command, b.block_excerpt
       FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id
      WHERE ${where} AND b.resolved_at IS NULL ${reasonFilter}
      ORDER BY b.id DESC LIMIT 1`,
    params,
  )
  return rows[0] ?? null
}
