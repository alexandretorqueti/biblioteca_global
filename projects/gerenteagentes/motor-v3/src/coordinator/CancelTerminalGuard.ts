import type { Pool, RowDataPacket } from 'mysql2/promise'

export interface CancelTerminalGuardQueryable {
  query: Pool['query']
}

export interface CancelTerminalState {
  found: boolean
  terminalStatus: string | null
}

/**
 * Guarda síncrona do endpoint `POST /api/motor/task/:id/cancel` (tarefa 1029).
 *
 * Antes deste guarda, o endpoint enfileirava `TASK_CANCEL_REQUESTED` para
 * qualquer tarefa; o `TaskCancelConsumer` rejeitava tarefas terminais com
 * `task_terminal` e a interface registrava um `cancel_requested` enganoso —
 * o usuário via "solicitado" para uma tarefa que nunca seria cancelada.
 *
 * A inspeção lê o MESMO fato canônico usado pelo consumidor
 * (`task_runtime_facts.terminal_status`), garantindo que a resposta HTTP e a
 * decisão do consumidor não divergem.
 */
export async function inspectCancelTerminalState(
  pool: CancelTerminalGuardQueryable,
  taskId: string,
): Promise<CancelTerminalState> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT f.terminal_status
       FROM tarefas t
       LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
      WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
      LIMIT 1`,
    [taskId, taskId],
  )
  const row = rows[0]
  if (!row) return { found: false, terminalStatus: null }
  const raw = row.terminal_status != null ? String(row.terminal_status).trim().toLowerCase() : ''
  return { found: true, terminalStatus: raw === '' ? null : raw }
}

/**
 * Resposta idempotente/explicativa para cancelamento de tarefa já terminal.
 * `accepted: false` + `alreadyTerminal: true` permitem que a Biblioteca
 * distinga "comando enfileirado" de "nada a fazer" sem interpretar texto.
 */
export function buildAlreadyTerminalCancelResponse(taskId: string, terminalStatus: string): {
  ok: true
  accepted: false
  alreadyTerminal: true
  taskId: string
  terminalStatus: string
  message: string
} {
  return {
    ok: true,
    accepted: false,
    alreadyTerminal: true,
    taskId,
    terminalStatus,
    message: `Tarefa já está em estado terminal (${terminalStatus}); nenhum comando de cancelamento foi enfileirado`,
  }
}
