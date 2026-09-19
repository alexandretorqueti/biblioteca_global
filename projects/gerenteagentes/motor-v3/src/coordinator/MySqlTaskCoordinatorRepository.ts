import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { TaskCoordinatorRepository, TaskLifecycleStatus, TaskSnapshot } from './TaskCoordinator.js'

interface TaskRow extends RowDataPacket {
  id: number
  external_id: string | null
  titulo: string
  descricao: string | null
  agente_id: string | null
  project_slug: string | null
  repo_path: string | null
  status: string | null
  paused_at: Date | string | null
  analysis_started_at: Date | string | null
  analysis_execution_id: string | null
  terminal_status: string | null
  subtask_count: number | string
  blocked_count: number | string
}

/** Repositório MySQL do claim inicial de análise. */
export class MySqlTaskCoordinatorRepository implements TaskCoordinatorRepository {
  constructor(private readonly pool: Pool) {}

  async getTask(taskId: string): Promise<TaskSnapshot | null> {
    const [rows] = await this.pool.query<TaskRow[]>(`
      SELECT
        t.id, t.external_id, t.titulo, t.descricao, t.repo_path, t.status, t.paused_at,
        COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug, '') AS agente_id,
        pc.slug AS project_slug,
        f.analysis_started_at, f.analysis_execution_id, f.terminal_status,
        (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id) AS subtask_count,
        (SELECT COUNT(*) FROM bloqueios b
          WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS blocked_count
      FROM tarefas t
      LEFT JOIN projetos_captados pc ON pc.id = t.projeto_id
      LEFT JOIN agentes a ON a.id = pc.agente_id
      LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
      WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
      LIMIT 1
    `, [taskId, taskId])

    const row = rows[0]
    return row ? this.mapTask(row) : null
  }

  async claimAnalysis(taskId: string, executionId: string): Promise<boolean> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const row = await this.lockTask(connection, taskId)
      if (!row || this.cannotStart(row)) {
        await connection.rollback()
        return false
      }

      await connection.query(
        `INSERT INTO task_runtime_facts (tarefa_id, created_at, updated_at)
         VALUES (?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE tarefa_id = VALUES(tarefa_id)`,
        [row.id],
      )
      const [result] = await connection.query<ResultSetHeader>(
        `UPDATE task_runtime_facts
         SET analysis_started_at = NOW(), analysis_execution_id = ?, updated_at = NOW()
         WHERE tarefa_id = ? AND analysis_started_at IS NULL
           AND analysis_execution_id IS NULL AND terminal_status IS NULL`,
        [executionId, row.id],
      )

      if (result.affectedRows !== 1) {
        await connection.rollback()
        return false
      }
      await connection.commit()
      return true
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async releaseAnalysisClaim(taskId: string, executionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE task_runtime_facts f
       INNER JOIN tarefas t ON t.id = f.tarefa_id
       SET f.analysis_started_at = NULL,
           f.analysis_execution_id = NULL,
           f.updated_at = NOW()
       WHERE (t.external_id = ? OR CAST(t.id AS CHAR) = ?)
         AND f.analysis_execution_id = ?`,
      [taskId, taskId, executionId],
    )
  }

  private async lockTask(connection: PoolConnection, taskId: string): Promise<TaskRow | null> {
    const [rows] = await connection.query<TaskRow[]>(`
      SELECT
        t.id, t.external_id, t.status, t.paused_at,
        f.analysis_started_at, f.analysis_execution_id, f.terminal_status,
        (SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id) AS subtask_count,
        (SELECT COUNT(*) FROM bloqueios b
          WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) AS blocked_count
      FROM tarefas t
      LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
      WHERE t.external_id = ? OR CAST(t.id AS CHAR) = ?
      LIMIT 1
      FOR UPDATE
    `, [taskId, taskId])
    return rows[0] ?? null
  }

  private cannotStart(row: Pick<TaskRow, 'paused_at' | 'analysis_started_at' | 'analysis_execution_id' | 'terminal_status' | 'subtask_count' | 'blocked_count' | 'status'>): boolean {
    return row.paused_at != null
      || row.analysis_started_at != null
      || row.analysis_execution_id != null
      || row.terminal_status != null
      || Number(row.subtask_count) > 0
      || Number(row.blocked_count) > 0
      || ['blocked', 'cancelled', 'completed', 'failed'].includes(String(row.status ?? '').toLowerCase())
  }

  private mapTask(row: TaskRow): TaskSnapshot {
    const terminal = row.terminal_status != null
    const paused = row.paused_at != null
    const status = terminal
      ? this.mapStatus(row.terminal_status)
      : paused
        ? 'paused'
        : row.analysis_started_at != null
          ? 'running'
          : this.mapStatus(row.status)
    return {
      taskId: String(row.external_id ?? row.id),
      title: String(row.titulo ?? ''),
      description: String(row.descricao ?? ''),
      agentId: String(row.agente_id ?? ''),
      projectSlug: row.project_slug ? String(row.project_slug) : null,
      repoPath: String(row.repo_path ?? ''),
      status,
      paused,
      terminal,
      analysisStartedAt: row.analysis_started_at ? new Date(row.analysis_started_at).toISOString() : null,
      subtaskCount: Number(row.subtask_count ?? 0),
    }
  }

  private mapStatus(value: string | null): TaskLifecycleStatus {
    switch (String(value ?? '').toLowerCase()) {
      case 'running': return 'running'
      case 'paused': return 'paused'
      case 'blocked': return 'blocked'
      case 'cancelled': case 'canceled': return 'cancelled'
      case 'completed': case 'done': case 'verified': return 'completed'
      case 'failed': case 'error': return 'failed'
      default: return 'planned'
    }
  }
}
