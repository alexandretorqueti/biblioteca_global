import type { Pool, RowDataPacket } from 'mysql2/promise'

/** Pontos que já possuem roteamento pelo GovernedFailureHandler. */
export const GOVERNED_FAILURE_POINTS = [
  'analysis_terminal',
  'analysis_model_fallback',
  'analysis_invalid_reply',
  'analysis_timeout',
  'worker_exhausted',
  'baseline_red',
  'gate_result',
  'monitor_recovery_failed',
  'deploy_dispatch_failed',
  'deploy_failed',
  'deploy_pre_gate_failed',
  'promotion_conflict',
  'queue_invalid_message',
  'queue_max_attempts',
  'queue_unexpected_state',
] as const

export type GovernedFailurePoint = typeof GOVERNED_FAILURE_POINTS[number]

function parseFlag(value: unknown): boolean {
  return ['1', 'true', 'on', 'yes', 'sim'].includes(String(value ?? '').trim().toLowerCase())
}

/**
 * Resolve flags por leitura, sem cache, para permitir rollback sem restart.
 * Ausência, valor inválido ou indisponibilidade da tabela são tratados como
 * desligado: o chamador mantém o ramo legado encapsulado como fallback.
 */
export function createGovernanceFlagResolver(pool: Pool): (key: string) => Promise<boolean> {
  return async (key: string): Promise<boolean> => {
    try {
      const [rows] = await pool.query<Array<RowDataPacket & { valor?: unknown }>>(
        'SELECT valor FROM motor_configuracoes WHERE chave = ? LIMIT 1',
        [key],
      )
      return parseFlag(rows[0]?.valor)
    } catch (error) {
      console.warn('[GovernanceRollout] não foi possível ler flag; usando fallback legado:', error instanceof Error ? error.message : String(error))
      return false
    }
  }
}

export function governanceFlagKey(point: GovernedFailurePoint | string): string {
  return `governed_failure_${point}`
}
