import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { TerminalFailureContext, TerminalFailureMessageHandler } from '../queue/TerminalFailureHandler.js'
import { insertOutboxMessage } from '../queue/outboxInsert.js'
import { createTaskBlockedMessage } from '../monitor/index.js'

/**
 * Persiste bloqueio idempotente quando uma subtarefa atinge falha terminal
 * na fila (ex.: HTTP 504 do Console, timeout do worker, erro de preparação
 * recorrente).
 *
 * Padrão derivado do `MySqlAnalysisFailureBlocker`:
 * - INSERT em `bloqueios` com NOT EXISTS para evitar duplicatas
 * - UPDATE da subtarefa para `blocked` na mesma transação
 * - Emissão de `TASK_BLOCKED` via outbox para o Monitor-Resolvedor
 * - Diagnóstico acionável em `block_excerpt` (origem, executionId, tentativa, erro)
 *
 * Idempotência: redelivery da mesma mensagem não cria bloqueio duplicado
 * (NOT EXISTS em `bloqueios` por `block_reason` + `subtarefa_id`).
 */
export class SubtaskTerminalFailureBlocker {
  constructor(private readonly pool: Pool) {}

  /**
   * Handler compatível com `TerminalFailureMessageHandler` — chamado pelo
   * `TerminalFailureRouter` antes do envio à DLQ.
   */
  readonly handle: TerminalFailureMessageHandler = async (context: TerminalFailureContext) => {
    await this.blockForTerminalFailure(context)
  }

  async blockForTerminalFailure(context: TerminalFailureContext): Promise<void> {
    const { message, attempt, reason, error } = context
    const subtaskId = Number(message.payload?.subtaskId)
    if (!Number.isInteger(subtaskId) || subtaskId <= 0) {
      // Mensagem sem subtaskId válido — não há o que bloquear.
      // O roteador loga e segue para DLQ sem persistir bloqueio órfão.
      console.warn(`[SubtaskTerminalFailureBlocker] mensagem ${message.messageId} sem subtaskId válido; bloqueio omitido`)
      return
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    const blockReason = 'subtask_terminal_failure'
    const blockCommand = `motor-v3:terminal:${message.type}`
    const blockExcerpt = JSON.stringify({
      messageType: message.type,
      executionId: message.executionId,
      attempt,
      reason: reason.slice(0, 500),
      error: errorMessage.slice(0, 1800),
      messageId: message.messageId,
    })

    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()

      // 1. INSERT bloqueio idempotente (NOT EXISTS por subtarefa + reason ativo)
      const [result] = await connection.query<ResultSetHeader>(
        `INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at)
         SELECT s.tarefa_id, s.id, ?, ?, ?, NOW()
           FROM subtarefas s
          WHERE s.id = ?
            AND NOT EXISTS (
              SELECT 1 FROM bloqueios b
               WHERE b.tarefa_id = s.tarefa_id
                 AND b.subtarefa_id = s.id
                 AND b.block_reason = ?
                 AND b.resolved_at IS NULL
            )
          LIMIT 1`,
        [blockReason, blockCommand, blockExcerpt, subtaskId, blockReason],
      )

      if (result.affectedRows === 0) {
        // Bloqueio já existe ou subtarefa inexistente — idempotência OK.
        await connection.commit()
        return
      }

      // 2. Atualizar status da subtarefa para 'blocked' (se ainda running)
      await connection.query(
        `UPDATE subtarefas SET status='blocked', resultado=?, updated_at=NOW()
          WHERE id=? AND status IN ('running','pending')`,
        [errorMessage.slice(0, 60_000), subtaskId],
      )

      // 3. Buscar ids para o evento TASK_BLOCKED
      const [rows] = await connection.query<Array<RowDataPacket & { id: number; tarefa_id: number }>>(
        `SELECT b.id, b.tarefa_id FROM bloqueios b
          WHERE b.subtarefa_id = ? AND b.block_reason = ? AND b.resolved_at IS NULL
          ORDER BY b.id DESC LIMIT 1`,
        [subtaskId, blockReason],
      )
      const blockRow = rows[0]

      // 4. Emitir TASK_BLOCKED via outbox (mesma transação)
      const blocked = createTaskBlockedMessage({
        taskId: message.taskId,
        executionId: `${message.executionId}-terminal-block`,
        correlationId: message.correlationId ?? message.messageId,
        causationId: message.messageId,
        payload: {
          blockReason,
          blockCommand,
          blockExcerpt: blockExcerpt.slice(0, 500),
          subtaskId,
          blockId: blockRow?.id != null ? Number(blockRow.id) : null,
          databaseTaskId: blockRow?.tarefa_id != null ? Number(blockRow.tarefa_id) : null,
        },
      })
      await insertOutboxMessage(connection, blocked, 'motor.monitor')

      await connection.commit()
    } catch (err) {
      await connection.rollback()
      throw err
    } finally {
      connection.release()
    }
  }
}
