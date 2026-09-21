import type { Pool, RowDataPacket } from 'mysql2/promise'

export interface DeployDiagnostics {
  canStart: boolean
  pendingRequests: number
  reasons: string[]
}

interface DeployCountRow extends RowDataPacket {
  pending: number | string
  running: number | string
}

interface ActiveTaskRow extends RowDataPacket {
  task_id: string | null
}

interface FailingTestRow extends RowDataPacket { total: number | string }

/**
 * Diagnóstico somente de leitura da fila de deploy.
 *
 * O diagnóstico não executa efeitos. `canStart` indica apenas que não há
 * impedimento persistido para a próxima mensagem de dispatch.
 */
export async function getDeployDiagnostics(pool: Pool): Promise<DeployDiagnostics> {
  const [deployRows] = await pool.query<DeployCountRow[]>(
    `SELECT
       SUM(status = 'pending') AS pending,
       SUM(status = 'running') AS running
     FROM deploy_requests`,
  )
  const pendingRequests = Number(deployRows[0]?.pending ?? 0)
  const runningRequests = Number(deployRows[0]?.running ?? 0)

  const [activeRows] = await pool.query<ActiveTaskRow[]>(
    `SELECT DISTINCT COALESCE(t.external_id, CAST(t.id AS CHAR)) AS task_id
       FROM tarefas t
       LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id
      WHERE (t.paused_at IS NULL AND f.terminal_status IS NULL AND f.analysis_started_at IS NOT NULL)
         OR EXISTS (
              SELECT 1 FROM subtarefas s
               WHERE s.tarefa_id = t.id
                 AND s.status IN ('running', 'delivered', 'verifying')
            )
      ORDER BY task_id
      LIMIT 10`,
  )

  const reasons: string[] = []
  const [testRows] = await pool.query<FailingTestRow[]>(
    `SELECT COUNT(*) AS total
       FROM test_runs tr
      WHERE tr.id IN (SELECT MAX(latest.id) FROM test_runs latest GROUP BY latest.projeto_id)
        AND tr.status != 'passed'`,
  )
  const failingProjects = Number(testRows[0]?.total ?? 0)
  if (failingProjects > 0) reasons.push(`${failingProjects} projeto(s) com gate de testes vermelho; deploy bloqueado`)
  if (runningRequests > 0) reasons.push(`${runningRequests} deploy(s) em andamento`)
  const activeTaskIds = activeRows.map(row => String(row.task_id ?? '')).filter(Boolean)
  if (activeTaskIds.length > 0) reasons.push(`tarefas ativas: ${activeTaskIds.join(', ')}`)
  if (pendingRequests === 0 && reasons.length === 0) {
    reasons.push('nenhuma solicitação de deploy pendente')
  }

  return {
    canStart: pendingRequests > 0 && reasons.length === 0,
    pendingRequests,
    reasons: reasons.length ? reasons : ['deploy pronto para iniciar'],
  }
}
