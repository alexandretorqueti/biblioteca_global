import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'

export interface DeployDrainDecision {
  active: boolean
  thresholdMinutes: number
  oldestPendingAgeMinutes: number | null
  oldestRequestId: number | null
}

interface ConfigRow extends RowDataPacket { valor: number | string | null }
interface PendingRow extends RowDataPacket {
  id: number
  age_minutes: number | string | null
}

/**
 * Avalia o dreno contra a mesma definição de pedido elegível usada pelo
 * despacho. O threshold pode ser fornecido pelo chamador quando a linha de
 * configuração já foi bloqueada na transação do claim.
 */
export async function evaluateDeployDrain(
  database: Pool | PoolConnection,
  lockedThresholdMinutes?: number,
): Promise<DeployDrainDecision> {
  let thresholdMinutes = lockedThresholdMinutes
  if (thresholdMinutes === undefined) {
    const [configRows] = await database.query<ConfigRow[]>(
      `SELECT CAST(JSON_UNQUOTE(valor) AS UNSIGNED) AS valor
         FROM motor_configuracoes
        WHERE chave = 'deploy_drain_threshold_minutes'
        LIMIT 1`,
    )
    thresholdMinutes = Math.max(0, Number(configRows[0]?.valor ?? 0))
  }

  const [pendingRows] = await database.query<PendingRow[]>(
    `SELECT dr.id,
            TIMESTAMPDIFF(MINUTE, dr.requested_at, NOW()) AS age_minutes
       FROM deploy_requests dr
      WHERE dr.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM bloqueios b
           WHERE b.tarefa_id = dr.tarefa_id AND b.resolved_at IS NULL
        )
      ORDER BY dr.requested_at ASC, dr.id ASC
      LIMIT 1`,
  )
  const oldest = pendingRows[0]
  const oldestPendingAgeMinutes = oldest ? Math.max(0, Number(oldest.age_minutes ?? 0)) : null
  return {
    active: thresholdMinutes > 0 && oldestPendingAgeMinutes != null && oldestPendingAgeMinutes >= thresholdMinutes,
    thresholdMinutes,
    oldestPendingAgeMinutes,
    oldestRequestId: oldest ? Number(oldest.id) : null,
  }
}
