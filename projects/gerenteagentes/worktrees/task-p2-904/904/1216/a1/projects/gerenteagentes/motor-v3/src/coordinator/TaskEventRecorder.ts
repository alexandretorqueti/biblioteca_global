import type { Pool } from 'mysql2/promise'

/**
 * Trilha imutável de eventos de tarefa (`tarefa_eventos`).
 *
 * A Biblioteca registra as ações do usuário (created/paused/deleted...) com
 * `origem='usuario'`; o Motor registra os fatos operacionais com
 * `origem='motor'` (auditoria, item 6 do incidente 862). Falha de auditoria
 * nunca deve derrubar o fluxo principal — o chamador decide capturar.
 */
export interface TaskEventSink {
  record(taskId: string, evento: string, ator?: string, payload?: Record<string, unknown> | null): Promise<void>
}

export class MySqlTaskEventRecorder implements TaskEventSink {
  constructor(private readonly pool: Pool) {}

  async record(taskId: string, evento: string, ator = 'motor', payload: Record<string, unknown> | null = null): Promise<void> {
    const numeric = /^\d+$/.test(taskId)
    const where = numeric ? 'external_id = ? OR CAST(id AS CHAR) = ?' : 'external_id = ?'
    const params: unknown[] = numeric
      ? [evento.slice(0, 40), ator.slice(0, 255), JSON.stringify(payload), taskId, taskId]
      : [evento.slice(0, 40), ator.slice(0, 255), JSON.stringify(payload), taskId]
    await this.pool.query(
      `INSERT INTO tarefa_eventos (tarefa_id, tarefa_external_id, evento, ator, origem, payload, created_at)
       SELECT id, external_id, ?, ?, 'motor', ?, NOW() FROM tarefas
       WHERE ${where}
       LIMIT 1`,
      params,
    )
  }
}
