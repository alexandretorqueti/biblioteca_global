import type { PoolConnection, RowDataPacket } from 'mysql2/promise'

export type ProviderPhase = 'analysis' | 'development' | 'monitor'

export interface ProviderCapacityDecision {
  available: boolean
  limitScope: 'provider' | null
  limitValue: number | null
}

export function providerFromModel(model: string | null | undefined): string | null {
  const value = String(model ?? '').trim()
  const slash = value.indexOf('/')
  return slash > 0 ? value.slice(0, slash) : null
}

/**
 * Verifica a cota do provider dentro da transação de reserva.
 * O chamador deve bloquear motor_configuracoes antes desta função; aqui a
 * linha de motor_provider_limits é sempre bloqueada antes das contagens.
 */
export async function providerHasCapacity(
  connection: PoolConnection,
  provider: string | null,
  phase: ProviderPhase,
): Promise<boolean> {
  return (await providerCapacityDecision(connection, provider, phase)).available
}

export async function providerCapacityDecision(
  connection: PoolConnection,
  provider: string | null,
  phase: ProviderPhase,
): Promise<ProviderCapacityDecision> {
  if (!provider) return { available: true, limitScope: null, limitValue: null }
  const [limitRows] = await connection.query<Array<RowDataPacket & {
    limite_execucao_total: number | string | null
    limite_analises: number | string | null
    limite_desenvolvimento: number | string | null
  }>>(
    `SELECT limite_execucao_total, limite_analises, limite_desenvolvimento
       FROM motor_provider_limits WHERE provider = ? LIMIT 1 FOR UPDATE`, [provider],
  )
  const limit = limitRows[0]
  if (!limit) return { available: true, limitScope: null, limitValue: null }
  const phaseLimit = phase === 'analysis' ? limit.limite_analises : phase === 'development' ? limit.limite_desenvolvimento : null
  const [rows] = await connection.query<Array<RowDataPacket & { analysis_count: number | string; development_count: number | string; monitor_count: number | string }>>(
    `SELECT
       (SELECT COUNT(*) FROM task_runtime_facts f
         WHERE f.provider = ? AND f.analysis_started_at IS NOT NULL
           AND f.analysis_execution_id IS NOT NULL AND f.terminal_status IS NULL) AS analysis_count,
       (SELECT COUNT(*) FROM subtarefas s
         WHERE s.provider = ? AND s.status IN ('running', 'delivered', 'verifying')) AS development_count,
       (SELECT COUNT(*) FROM motor_active_executions e
         WHERE e.provider = ? AND e.phase IN ('monitor', 'postdeploy_monitor') AND e.expires_at > NOW()) AS monitor_count`,
    [provider, provider, provider],
  )
  const counts = rows[0] ?? { analysis_count: 0, development_count: 0, monitor_count: 0 }
  const analysis = Number(counts.analysis_count ?? 0)
  const development = Number(counts.development_count ?? 0)
  const monitor = Number(counts.monitor_count ?? 0)
  const total = analysis + development + monitor
  const totalLimit = limit.limite_execucao_total == null ? null : Number(limit.limite_execucao_total)
  if (totalLimit != null && total >= totalLimit) return { available: false, limitScope: 'provider', limitValue: totalLimit }
  if (phaseLimit != null) {
    const current = phase === 'analysis' ? analysis : phase === 'development' ? development : monitor
    if (current >= Number(phaseLimit)) return { available: false, limitScope: 'provider', limitValue: Number(phaseLimit) }
  }
  return { available: true, limitScope: null, limitValue: null }
}
