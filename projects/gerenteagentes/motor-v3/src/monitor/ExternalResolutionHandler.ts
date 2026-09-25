import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createQueueMessage, insertOutboxMessage, type QueueMessage } from '../queue/index.js'
import { createTaskUnblockedMessage } from './TaskBlockedEvent.js'

/**
 * Resolução externa governada (camada C do invariante de conclusão).
 *
 * Incidente da tarefa 820 (2026-09-25): um ator externo resolveu bloqueios e
 * marcou a última subtarefa como 'verified' via SQL direto, contornando a
 * transação de conclusão do motor. O estado ficou impossível: todas as
 * subtarefas finais, sem fatos de conclusão, sem deploy, presa em 'ready'.
 *
 * Este handler é o caminho canônico para intervenções externas: resolve
 * bloqueios, opcionalmente finaliza uma subtarefa e reconcilia a conclusão da
 * tarefa — tudo na mesma transação, com auditoria (tarefa_eventos) e outbox.
 * Com ele, ninguém precisa (nem deve) escrever SQL direto nas tabelas do motor.
 *
 * Idempotente: bloqueios já resolvidos não contam; subtarefa já finalizada não
 * é re-atualizada; conclusão com terminal_status já gravado é no-op.
 */

export interface ExternalResolutionInput {
  /** external_id ('task-p2-820') ou id numérico como string. */
  taskId: string
  /** Motivo humano da intervenção (obrigatório). */
  motivo: string
  /** Identificação do ator externo (obrigatório). */
  resolvedBy: string
  /** Bloqueios específicos a resolver; ausente = todos os ativos da tarefa. */
  blockIds?: number[]
  /** Subtarefa a marcar como verified (opcional; já deve pertencer à tarefa). */
  subtaskId?: number
  /**
   * true → emite DEPLOY_REQUESTED (o motor integra/deploya pelo fluxo normal).
   * false/ausente → só conclui; se a integração já foi deployada por fora,
   * nada é re-disparado aqui (a recuperação de boot pode reavaliar depois).
   */
  requestDeploy?: boolean
}

export interface ExternalResolutionResult {
  ok: true
  taskId: string
  databaseTaskId: number
  blockersResolved: number
  subtaskVerified: boolean
  completed: boolean
  deployRequested: boolean
  requeued: boolean
  messageIds: string[]
}

export type ExternalResolutionErrorCode = 'not_found' | 'invalid_input' | 'subtask_not_found'

export class ExternalResolutionError extends Error {
  constructor(readonly code: ExternalResolutionErrorCode, message: string) {
    super(message)
    this.name = 'ExternalResolutionError'
  }
}

interface TaskRow extends RowDataPacket {
  id: number
  external_id: string | null
  tipo: string
}

export class ExternalResolutionHandler {
  constructor(private readonly pool: Pool) {}

  async handle(input: ExternalResolutionInput): Promise<ExternalResolutionResult> {
    const motivo = String(input.motivo ?? '').trim()
    const resolvedBy = String(input.resolvedBy ?? '').trim()
    if (!motivo) throw new ExternalResolutionError('invalid_input', 'motivo é obrigatório')
    if (!resolvedBy) throw new ExternalResolutionError('invalid_input', 'resolvedBy é obrigatório')
    const blockIds = Array.isArray(input.blockIds)
      ? input.blockIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0)
      : undefined

    const connection: PoolConnection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      // Suprime o trigger de conclusão (camada A): esta transação já reconcilia
      // os fatos por conta própria, com auditoria completa.
      await connection.query('SET @motor_completing := 1')

      const [taskRows] = await connection.query<TaskRow[]>(
        `SELECT t.id, t.external_id, t.tipo
           FROM tarefas t
          WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
          LIMIT 1 FOR UPDATE`,
        [input.taskId, input.taskId],
      )
      const task = taskRows[0]
      if (!task) {
        await connection.rollback()
        throw new ExternalResolutionError('not_found', `Tarefa ${input.taskId} não encontrada`)
      }
      const databaseTaskId = Number(task.id)
      const taskId = String(task.external_id ?? task.id)
      const messageIds: string[] = []

      // 1) Bloqueios
      const [blockers] = await connection.query<ResultSetHeader>(
        blockIds && blockIds.length > 0
          ? `UPDATE bloqueios SET resolved_at = NOW()
              WHERE tarefa_id = ? AND resolved_at IS NULL AND id IN (${blockIds.map(() => '?').join(',')})`
          : 'UPDATE bloqueios SET resolved_at = NOW() WHERE tarefa_id = ? AND resolved_at IS NULL',
        blockIds && blockIds.length > 0 ? [databaseTaskId, ...blockIds] : [databaseTaskId],
      )
      const blockersResolved = Number(blockers?.affectedRows ?? 0)

      // 2) Subtarefa (opcional)
      let subtaskVerified = false
      if (input.subtaskId != null) {
        const subtaskId = Number(input.subtaskId)
        if (!Number.isInteger(subtaskId) || subtaskId <= 0) {
          await connection.rollback()
          throw new ExternalResolutionError('invalid_input', 'subtaskId inválido')
        }
        const [updated] = await connection.query<ResultSetHeader>(
          `UPDATE subtarefas
              SET status = 'verified',
                  resultado = ?,
                  finalizada_em = NOW(),
                  updated_at = NOW()
            WHERE id = ? AND tarefa_id = ?
              AND status NOT IN ('verified', 'superseded')`,
          [`Resolução externa (${resolvedBy}): ${motivo}`.slice(0, 60_000), subtaskId, databaseTaskId],
        )
        if (Number(updated.affectedRows) === 1) {
          subtaskVerified = true
        } else {
          const [existing] = await connection.query<Array<RowDataPacket & { id: number }>>(
            'SELECT id FROM subtarefas WHERE id = ? AND tarefa_id = ? LIMIT 1',
            [subtaskId, databaseTaskId],
          )
          if (existing.length === 0) {
            await connection.rollback()
            throw new ExternalResolutionError('subtask_not_found', `Subtarefa ${subtaskId} não pertence à tarefa ${taskId}`)
          }
          // Já estava finalizada: idempotência, segue o fluxo.
        }
      }

      // 3) Conclusão, se todas as subtarefas estiverem finais
      const [countRows] = await connection.query<Array<RowDataPacket & { total: number | string; finais: number | string | null }>>(
        `SELECT COUNT(*) AS total,
                SUM(status IN ('verified', 'superseded')) AS finais
           FROM subtarefas
          WHERE tarefa_id = ?
          FOR UPDATE`,
        [databaseTaskId],
      )
      const total = Number(countRows[0]?.total ?? 0)
      const finais = Number(countRows[0]?.finais ?? 0)
      let completed = false
      let deployRequested = false
      let requeued = false

      if (total > 0 && finais === total) {
        const [factRows] = await connection.query<Array<RowDataPacket & { terminal_status: string | null }>>(
          'SELECT terminal_status FROM task_runtime_facts WHERE tarefa_id = ? LIMIT 1 FOR UPDATE',
          [databaseTaskId],
        )
        const alreadyTerminal = factRows.length > 0 && factRows[0]?.terminal_status != null
        await connection.query(
          `INSERT INTO task_runtime_facts (tarefa_id, terminal_status, terminal_at, integration_confirmed_at, created_at, updated_at)
           VALUES (?, 'completed', NOW(), NOW(), NOW(), NOW())
           ON DUPLICATE KEY UPDATE terminal_status = 'completed', terminal_at = COALESCE(terminal_at, NOW()),
             integration_confirmed_at = COALESCE(integration_confirmed_at, NOW()), updated_at = NOW()`,
          [databaseTaskId],
        )
        completed = true

        const taskCompleted = createQueueMessage({
          type: 'TASK_EXECUTION_COMPLETED', taskId,
          executionId: `exec-external-resolution-${taskId}-${Date.now()}`,
          payload: { reason: 'external_resolution', resolvedBy, motivo: motivo.slice(0, 500), reconciled: !alreadyTerminal },
        })
        await insertOutboxMessage(connection, taskCompleted)
        messageIds.push(taskCompleted.messageId)

        if (input.requestDeploy === true && String(task.tipo ?? '') === 'desenvolvimento') {
          const deployRequest = createQueueMessage({
            type: 'DEPLOY_REQUESTED', taskId,
            executionId: `deploy-external-${taskId}-${Date.now()}`,
            causationId: taskCompleted.messageId,
            payload: { reason: 'external_resolution', resolvedBy },
          })
          await insertOutboxMessage(connection, deployRequest)
          messageIds.push(deployRequest.messageId)
          deployRequested = true
        }

        await connection.query('DELETE FROM motor_execution_wait_queue WHERE tarefa_id = ?', [databaseTaskId])
      } else {
        // Tarefa ainda tem trabalho pendente: devolve ao fluxo normal.
        const ready = createQueueMessage({
          type: 'TASK_READY_FOR_PROGRAMMING', taskId,
          executionId: `exec-external-resolution-${taskId}-${Date.now()}`,
          payload: { reason: 'external_resolution', resolvedBy },
        })
        await insertOutboxMessage(connection, ready)
        messageIds.push(ready.messageId)
        requeued = true
      }

      // 4) TASK_UNBLOCKED para o fluxo de auditoria/retomada do monitor
      if (blockersResolved > 0) {
        const unblocked = createTaskUnblockedMessage({
          taskId,
          executionId: `external-resolution-${taskId}-${Date.now()}`,
          payload: {
            blockId: blockIds && blockIds.length > 0 ? blockIds[0]! : 0,
            blockReason: 'external_resolution',
            databaseTaskId,
            resolvedBy: 'usuario',
          },
        })
        await insertOutboxMessage(connection, unblocked)
        messageIds.push(unblocked.messageId)
      }

      // 5) Auditoria na trilha da tarefa (mesma transação)
      await connection.query(
        `INSERT INTO tarefa_eventos (tarefa_id, tarefa_external_id, evento, ator, origem, payload)
         VALUES (?, ?, 'external_resolution', ?, 'api', ?)`,
        [databaseTaskId, task.external_id, resolvedBy.slice(0, 255),
          JSON.stringify({
            motivo: motivo.slice(0, 500), resolvedBy, blockIds: blockIds ?? null,
            subtaskId: input.subtaskId ?? null, blockersResolved, subtaskVerified,
            completed, deployRequested, requeued, messageIds,
          })],
      )

      await connection.commit()
      return {
        ok: true, taskId, databaseTaskId, blockersResolved, subtaskVerified,
        completed, deployRequested, requeued, messageIds,
      }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      try { await connection.query('SET @motor_completing := NULL') } catch { /* não impede a liberação */ }
      connection.release()
    }
  }
}
