import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

export interface DeployRequestCancellation {
  blocker: string
  resolvedBy: string
  motivo: string
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
): Promise<{ cancelled: number; activeRunning: number }> {
  const reason = [
    'Cancelamento administrativo de deploy',
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
  return { cancelled: Number(updated.affectedRows ?? 0), activeRunning }
}
