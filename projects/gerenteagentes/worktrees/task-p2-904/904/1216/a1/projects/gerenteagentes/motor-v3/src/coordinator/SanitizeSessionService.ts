import type { Pool, Connection } from 'mysql2/promise'

export interface SanitizeSessionResult {
  ok: boolean
  sessionsArchived: number
  analysisReset: boolean
  message: string
  error?: string
}

export interface ConsoleArchiver {
  archiveSession(sessionKey: string): Promise<{ archived: boolean; error?: string }>
}

/**
 * Detecta bloqueio por análise e faz reset transacional.
 *
 * Detecção:
 * (a) terminal_status vazio E bloqueio ativo com block_reason = 'analysis_failed'
 * (b) evento analysis_failed recente (7 dias) sem analysis_completed subsequente
 *
 * Reset transacional (atómico):
 * 1. DELETE task_runtime_facts
 * 2. DELETE bloqueios analysis_failed
 * 3. UPDATE tarefas SET paused_at = NULL
 * 4. INSERT evento analysis_reset em tarefa_eventos
 *
 * Documentação: docs/SANITIZE-SESSION-RESET-ANALISE.md
 */
export class SanitizeSessionService {
  constructor(
    private readonly pool: Pool,
    private readonly consoleArchiver?: ConsoleArchiver,
  ) {}

  async execute(taskId: string): Promise<SanitizeSessionResult> {
    // 1. Carrega a tarefa
    const [taskRows] = await this.pool.query<any[]>(
      `SELECT t.id, t.external_id, t.paused_at,
              COALESCE(f.terminal_status, '') AS terminal_status,
              f.analysis_execution_id
         FROM tarefas t
         LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
        WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
        LIMIT 1`,
      [taskId, taskId],
    )
    const task = taskRows[0]
    if (!task) {
      return { ok: false, sessionsArchived: 0, analysisReset: false, message: 'Task not found', error: 'not_found' }
    }
    const numericTaskId = Number(task.id)

    // 2. Detecta bloqueio por análise
    const analysisBlocked = await this.detectAnalysisBlock(numericTaskId, task)

    // 3. Arquivamento de sessão no Console (best-effort, fora da transação)
    let sessionsArchived = 0
    if (this.consoleArchiver) {
      try {
        const result = await this.consoleArchiver.archiveSession(task.external_id)
        if (result.archived) sessionsArchived = 1
      } catch {
        // best-effort: erro de arquivamento não derruba o fluxo
      }
    }

    if (!analysisBlocked) {
      return {
        ok: true,
        sessionsArchived,
        analysisReset: false,
        message: 'Sessão arquivada. Nenhum bloqueio de análise detectado.',
      }
    }

    // 4. Reset transacional atômico
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()

      await connection.query('DELETE FROM task_runtime_facts WHERE tarefa_id = ?', [numericTaskId])
      await connection.query(
        `DELETE FROM bloqueios WHERE tarefa_id = ? AND block_reason = 'analysis_failed'`,
        [numericTaskId],
      )
      await connection.query('UPDATE tarefas SET paused_at = NULL WHERE id = ?', [numericTaskId])

      const payload = JSON.stringify({ previousStatus: 'blocked', reason: 'sanitize_session' })
      await connection.query(
        `INSERT INTO tarefa_eventos (tarefa_id, tarefa_external_id, evento, ator, origem, payload, created_at)
         SELECT id, external_id, 'analysis_reset', 'motor', 'motor', ?, NOW()
         FROM tarefas WHERE id = ? LIMIT 1`,
        [payload, numericTaskId],
      )

      await connection.commit()
      return {
        ok: true,
        sessionsArchived,
        analysisReset: true,
        message: 'Sessão arquivada e análise resetada. Tarefa pronta para nova análise.',
      }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async detectAnalysisBlock(numericTaskId: number, task: { terminal_status: string }): Promise<boolean> {
    // (a) terminal_status vazio E bloqueio ativo analysis_failed
    if (!task.terminal_status) {
      const [blockerRows] = await this.pool.query<any[]>(
        `SELECT id FROM bloqueios
         WHERE tarefa_id = ? AND resolved_at IS NULL AND block_reason = 'analysis_failed'
         LIMIT 1`,
        [numericTaskId],
      )
      if (blockerRows.length > 0) return true
    }

    // (b) evento analysis_failed recente (7 dias) sem analysis_completed subsequente
    const [eventRows] = await this.pool.query<any[]>(
      `SELECT evento, created_at FROM tarefa_eventos
       WHERE tarefa_id = ? AND evento IN ('analysis_failed', 'analysis_completed')
         AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY created_at DESC LIMIT 1`,
      [numericTaskId],
    )
    if (eventRows.length > 0 && eventRows[0].evento === 'analysis_failed') return true

    return false
  }
}
