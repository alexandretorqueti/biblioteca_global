import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

export interface DeployRequestCancellation {
  blocker: string
  resolvedBy: string
  motivo: string
  /**
   * A conclusão administrativa sem intenção de deploy precisa deixar uma
   * adjudicação persistida. Sem ela, enqueueCompletedRecoveries interpreta a
   * ausência de request como trabalho pendente e ressuscita o deploy.
   */
  createTombstone?: boolean
}

/**
 * Fecha pedidos que ainda não podem ter iniciado um deploy remoto. Um pedido
 * pode estar `running` enquanto seu batch continua `pending`: o claim do lote
 * o reserva antes do blue-green começar. Esse caso ainda é dispensável. Um
 * batch `running` nunca é alterado aqui.
 */
export async function cancelUnstartedDeployRequests(
  connection: PoolConnection,
  taskId: number,
  cancellation: DeployRequestCancellation,
): Promise<{ cancelled: number; activeRunning: number; tombstoneCreated: number }> {
  const reason = [
    cancellation.createTombstone ? 'Adjudicação administrativa sem deploy' : 'Cancelamento administrativo de deploy',
    `blocker=${cancellation.blocker}`,
    `resolvedBy=${cancellation.resolvedBy}`,
    `motivo=${cancellation.motivo}`,
  ].join('; ').slice(0, 60_000)

  const [updated] = await connection.query<ResultSetHeader>(
    `UPDATE deploy_requests dr
       LEFT JOIN deploy_batches db ON db.batch_id = dr.batch_id
        SET dr.status='cancelled', dr.last_error=?, dr.finished_at=NOW(), dr.updated_at=NOW()
      WHERE dr.tarefa_id=?
        AND (
          dr.status='pending'
          OR (dr.status='running' AND db.status='pending' AND db.started_at IS NULL)
        )`,
    [reason, taskId],
  )
  const [activeRows] = await connection.query<Array<RowDataPacket & { total: number | string }>>(
    `SELECT COUNT(*) AS total
       FROM deploy_requests dr
       LEFT JOIN deploy_batches db ON db.batch_id = dr.batch_id
      WHERE dr.tarefa_id=? AND dr.status='running'
        AND (db.status IS NULL OR db.status <> 'pending' OR db.started_at IS NOT NULL)`,
    [taskId],
  )
  const activeRunning = Number(activeRows[0]?.total ?? 0)
  if (activeRunning > 0) {
    console.warn(`[Motor v3] Deploy em execução preservado ao finalizar tarefa ${taskId}: ${activeRunning} request(s)`)
  }

  let tombstoneCreated = 0
  if (cancellation.createTombstone) {
    // Serializa a decisão com acceptRequest(), que também bloqueia a tarefa
    // antes de criar um request. Assim, duas resoluções administrativas não
    // conseguem produzir dois tombeaux para a mesma geração.
    await connection.query('SELECT id FROM tarefas WHERE id=? FOR UPDATE', [taskId])
    const [tombstone] = await connection.query<ResultSetHeader>(
      `INSERT INTO deploy_requests
         (tarefa_id,repo_path,status,requested_commit,base_branch,generation,parent_generation,last_error,requested_at,finished_at,updated_at)
       SELECT t.id,
              COALESCE(pmc.repo_path, ''),
              'cancelled',
              (SELECT tr.commit_sha
                 FROM test_runs tr
                WHERE tr.tarefa_id=t.id AND tr.phase='pre_deploy'
                ORDER BY tr.finished_at DESC, tr.id DESC LIMIT 1),
              pmc.branch_trabalho,
              (SELECT COALESCE(MAX(s.generation), 1) FROM subtarefas s WHERE s.tarefa_id=t.id),
              NULL, ?, NOW(), NOW(), NOW()
         FROM tarefas t
         LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id=t.projeto_id
        WHERE t.id=?
          AND NOT EXISTS (SELECT 1 FROM deploy_requests dr WHERE dr.tarefa_id=t.id)`,
      [reason, taskId],
    )
    tombstoneCreated = Number(tombstone.affectedRows ?? 0)
  }
  return { cancelled: Number(updated.affectedRows ?? 0), activeRunning, tombstoneCreated }
}
