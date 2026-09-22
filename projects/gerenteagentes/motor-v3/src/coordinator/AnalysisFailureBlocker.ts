import type { Pool, ResultSetHeader } from 'mysql2/promise'

export interface AnalysisFailureInfo {
  executionId: string
  attempt: number
  error: string
}

/** Porta de persistência do bloqueio de falha definitiva de análise. */
export interface AnalysisFailureSink {
  blockForAnalysisFailure(taskId: string, info: AnalysisFailureInfo): Promise<void>
}

/**
 * Falha definitiva de análise → `bloqueios` → status derivado `blocked`
 * (estação Atenção), item 2 da auditoria do incidente 862.
 *
 * Sem este registro a tarefa voltava silenciosamente para `planned` (ou
 * congelava órfã em `analyzing`) e o usuário nunca era surface-ado do erro.
 * Idempotente: não duplica bloqueio `analysis_failed` não resolvido da mesma
 * tarefa (redeliveries/DLQ não geram novas linhas).
 */
export class MySqlAnalysisFailureBlocker implements AnalysisFailureSink {
  constructor(private readonly pool: Pool) {}

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
    const [result] = await this.pool.query<ResultSetHeader>(
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
      // desfechos aceitáveis para uma chamada idempotente.
      return
    }
  }
}
