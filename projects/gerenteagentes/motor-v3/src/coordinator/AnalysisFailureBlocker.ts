import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { insertOutboxMessage } from '../queue/index.js'
import { createTaskBlockedMessage } from '../monitor/index.js'

export interface AnalysisFailureInfo {
  executionId: string
  attempt: number
  error: string
}

/** Porta de persistência do bloqueio de falha definitiva de análise. */
export interface AnalysisFailureSink {
  blockForAnalysisFailure(taskId: string, info: AnalysisFailureInfo): Promise<void>
  recordProjectSetupFailure?(taskId: string, info: AnalysisFailureInfo): Promise<void>
}

/**
 * Evidência da falha terminal de RECUPERAÇÃO de sessão de análise
 * (incidente 1137, 2026-11-27): a recuperação do reconciliador morreu sem
 * deixar bloqueio e a tarefa ficou em limbo (nem analisada, nem bloqueada).
 */
export interface AnalysisRecoveryFailureInfo {
  /** id da linha em `analyst_task_sessions` (sessão que falhou). */
  sessionId: number | string | null
  /** claim de análise da tentativa que falhou (pode ser nulo em cenários órfãos). */
  executionId: string | null
  /** close_reason aplicado à sessão ('analysis_recovery_failed' | 'recovery_session_failed'). */
  closeReason?: string | null
  error: string
}

/** Porta de persistência do bloqueio de falha terminal da recuperação de análise. */
export interface AnalysisRecoveryFailureSink {
  blockForAnalysisRecoveryFailure(taskId: string, info: AnalysisRecoveryFailureInfo): Promise<void>
}

/**
 * Falha definitiva de análise → `bloqueios` → status derivado `blocked`
 * (estação Atenção), item 2 da auditoria do incidente 862.
 *
 * Sem este registro a tarefa voltava silenciosamente para `planned` (ou
 * congelava órfã em `analyzing`) e o usuário nunca era surface-ado do erro.
 * Idempotente: não duplica bloqueio `analysis_failed` não resolvido da mesma
 * tarefa (redeliveries/DLQ não geram novas linhas).
 *
 * Monitor-Resolvedor: quando o bloqueio é criado, emite `TASK_BLOCKED` na
 * MESMA transação (via outbox) para acionar o Monitor automaticamente.
 * Especificação: gerenteagentes/docs/MONITOR-RESOLVEDOR-DE-BLOQUEIOS.md
 */
export class MySqlAnalysisFailureBlocker implements AnalysisFailureSink {
  constructor(private readonly pool: Pool) {}

  async recordProjectSetupFailure(taskId: string, info: AnalysisFailureInfo): Promise<void> {
    await this.pool.query(
      `UPDATE projetos_captados pc
         INNER JOIN tarefas t ON t.projeto_id = pc.id
          SET pc.setup_status='failed', pc.setup_error=?, pc.updated_at=NOW()
       WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?`,
      [info.error.slice(0, 1800), taskId, taskId],
    )
  }

  async blockForAnalysisFailure(taskId: string, info: AnalysisFailureInfo): Promise<void> {
    const numeric = /^\d+$/.test(taskId)
    const where = numeric ? '(t.external_id = ? OR CAST(t.id AS CHAR) = ?)' : 't.external_id = ?'
    const excerpt = JSON.stringify({
      executionId: info.executionId,
      attempt: info.attempt,
      error: info.error.slice(0, 1800),
    })
    const params: unknown[] = numeric
      ? [`analysis_failed`, 'TASK_RESUME_REQUESTED', excerpt, taskId, taskId]
      : [`analysis_failed`, 'TASK_RESUME_REQUESTED', excerpt, taskId]
    const taskParams: unknown[] = numeric ? [taskId, taskId] : [taskId]
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [result] = await connection.query<ResultSetHeader>(
        `INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at)
         SELECT t.id, NULL, ?, ?, ?, NOW() FROM tarefas t
         WHERE ${where}
           AND NOT EXISTS (
             SELECT 1 FROM bloqueios b
             WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL AND b.block_reason = 'analysis_failed'
           )
         LIMIT 1`,
        params,
      )
      if (result.affectedRows === 0) {
        // Tarefa inexistente ou bloqueio analysis_failed já ativo — ambos são
        // desfechos aceitáveis para uma chamada idempotente. Sem evento novo.
        await connection.commit()
        return
      }
      const [rows] = await connection.query<Array<RowDataPacket & { id: number; tarefa_id: number }>>(
        `SELECT b.id, b.tarefa_id FROM bloqueios b
         INNER JOIN tarefas t ON t.id = b.tarefa_id
         WHERE ${where} AND b.resolved_at IS NULL AND b.block_reason = 'analysis_failed'
         ORDER BY b.id DESC LIMIT 1`,
        taskParams,
      )
      const blocked = createTaskBlockedMessage({
        taskId,
        executionId: `${info.executionId}-block`,
        payload: {
          blockReason: 'analysis_failed',
          blockCommand: 'TASK_RESUME_REQUESTED',
          blockExcerpt: excerpt.slice(0, 500),
          blockId: rows[0]?.id != null ? Number(rows[0].id) : null,
          databaseTaskId: rows[0]?.tarefa_id != null ? Number(rows[0].tarefa_id) : null,
        },
      })
      await insertOutboxMessage(connection, blocked, 'motor.monitor')
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  /**
   * Falha terminal da RECUPERAÇÃO de análise → `bloqueios`
   * (`block_reason='analysis_recovery_failed'`) → status derivado `blocked`
   * (estação Atenção) — incidente 1137 (2026-11-27): após 2x
   * `analysis_recovery_failed` o motor parava sem criar bloqueio e a tarefa
   * ficava em limbo, invisível e irresolúvel pela estação.
   *
   * Reaproveita o padrão idempotente de `blockForAnalysisFailure`: NOT EXISTS
   * de bloqueio não resolvido com a mesma razão (redelivery/segunda falha não
   * duplica) + `TASK_BLOCKED` no outbox `motor.monitor` na MESMA transação do
   * INSERT, acionando o Monitor-Resolvedor. A retomada pelo caminho canônico
   * (`analysis_recovery_failed` → TASK_RESUME_REQUESTED) é tratada no
   * TaskUnblockedConsumer no mesmo ramo de `analysis_failed`.
   *
   * Contagem de tentativas no excerpt: nº de eventos `analysis_recovery_failed`
   * da tarefa em `tarefa_eventos` (inclui o recém-registrado quando o
   * chamador grava o evento antes), com fallback para as linhas de
   * `motor_agent_session_failures` quando a trilha de eventos estiver vazia;
   * mínimo 1.
   */
  async blockForAnalysisRecoveryFailure(taskId: string, info: AnalysisRecoveryFailureInfo): Promise<void> {
    const numeric = /^\d+$/.test(taskId)
    const where = numeric ? '(t.external_id = ? OR CAST(t.id AS CHAR) = ?)' : 't.external_id = ?'
    const taskParams: unknown[] = numeric ? [taskId, taskId] : [taskId]
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [countRows] = await connection.query<Array<RowDataPacket & { tarefa_id: number; event_count: number | string; failure_rows: number | string }>>(
        `SELECT t.id AS tarefa_id,
                (SELECT COUNT(*) FROM tarefa_eventos te
                  WHERE te.tarefa_id = t.id AND te.evento = 'analysis_recovery_failed') AS event_count,
                (SELECT COUNT(*) FROM motor_agent_session_failures mf
                  WHERE mf.tarefa_id = t.id) AS failure_rows
           FROM tarefas t
          WHERE ${where}
          LIMIT 1`,
        taskParams,
      )
      const target = countRows[0]
      if (!target) {
        // Tarefa inexistente — desfecho aceitável (mesma semântica do bloqueio de análise).
        await connection.commit()
        return
      }
      const eventCount = Number(target.event_count ?? 0)
      const failureRows = Number(target.failure_rows ?? 0)
      const recoveryAttempts = Math.max(eventCount, failureRows, 1)
      const excerpt = JSON.stringify({
        sessionId: info.sessionId ?? null,
        executionId: info.executionId ?? null,
        closeReason: info.closeReason ?? 'analysis_recovery_failed',
        error: info.error.slice(0, 1800),
        recoveryAttempts,
      })
      const params: unknown[] = numeric
        ? ['analysis_recovery_failed', 'TASK_RESUME_REQUESTED', excerpt, taskId, taskId]
        : ['analysis_recovery_failed', 'TASK_RESUME_REQUESTED', excerpt, taskId]
      const [result] = await connection.query<ResultSetHeader>(
        `INSERT INTO bloqueios (tarefa_id, subtarefa_id, block_reason, block_command, block_excerpt, blocked_at)
         SELECT t.id, NULL, ?, ?, ?, NOW() FROM tarefas t
         WHERE ${where}
           AND NOT EXISTS (
             SELECT 1 FROM bloqueios b
             WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL AND b.block_reason = 'analysis_recovery_failed'
           )
         LIMIT 1`,
        params,
      )
      if (result.affectedRows === 0) {
        // Tarefa inexistente ou bloqueio analysis_recovery_failed já ativo —
        // ambos são desfechos aceitáveis para uma chamada idempotente.
        await connection.commit()
        return
      }
      const [rows] = await connection.query<Array<RowDataPacket & { id: number; tarefa_id: number }>>(
        `SELECT b.id, b.tarefa_id FROM bloqueios b
         INNER JOIN tarefas t ON t.id = b.tarefa_id
         WHERE ${where} AND b.resolved_at IS NULL AND b.block_reason = 'analysis_recovery_failed'
         ORDER BY b.id DESC LIMIT 1`,
        taskParams,
      )
      const blocked = createTaskBlockedMessage({
        taskId,
        executionId: `${info.executionId ?? `recovery-${info.sessionId ?? 'task'}`}-block`,
        payload: {
          blockReason: 'analysis_recovery_failed',
          blockCommand: 'TASK_RESUME_REQUESTED',
          blockExcerpt: excerpt.slice(0, 500),
          blockId: rows[0]?.id != null ? Number(rows[0].id) : null,
          databaseTaskId: rows[0]?.tarefa_id != null ? Number(rows[0].tarefa_id) : Number(target.tarefa_id),
        },
      })
      await insertOutboxMessage(connection, blocked, 'motor.monitor')
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }
}
