import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

/**
 * Fases com TTL fixo em `motor_active_executions` que dependem exclusivamente
 * do `finally`/unregister do próprio processo para remover a linha. Se o
 * processo morre/reinicia no meio da execução, ou o DELETE de unregister falha
 * (os consumidores apenas `console.warn`), a linha expirada permanece para
 * sempre. Nenhum outro reconciliador varre essas fases por expiração
 * (tarefa 1026).
 */
const SWEEP_PHASES_SQL = "phase IN ('monitor', 'postdeploy_monitor')"

export interface ActiveExecutionSweeperConfig {
  /** Intervalo do ciclo periódico. Default: 5 minutos. */
  intervalMs?: number
}

export interface ActiveExecutionSweepSummary {
  /** Linhas expiradas removidas neste ciclo. */
  swept: number
  /** Linhas ainda expiradas após o ciclo (esperado: 0). */
  remainingExpired: number
}

/**
 * Sweeper de execuções expiradas de monitor/postdeploy_monitor.
 *
 * Remove de `motor_active_executions` SOMENTE linhas com
 * `phase IN ('monitor','postdeploy_monitor') AND expires_at <= NOW()`.
 * Execuções vigentes (expires_at futuro) e leases de 'analysis'/'development'
 * (geridos por heartbeat e pelos reconciliadores próprios) nunca são alvo.
 *
 * Operação idempotente: o DELETE casa apenas registros já expirados; ciclos
 * repetidos sem linhas expiradas retornam `swept = 0` sem erro. Falhas de
 * banco são registradas em log sem derrubar o processo nem o timer.
 *
 * Padrão de lifecycle/guarda seguido de `MonitorBlockerReconciler` e do
 * timer `deployOrphanBatchReconciler` do start.ts.
 */
export class ActiveExecutionSweeper {
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private reconciling = false

  constructor(
    private readonly pool: Pool,
    config: ActiveExecutionSweeperConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? 300_000
  }

  /**
   * Uma passagem de limpeza. Segura para repetir (idempotente) e com guarda
   * anti-reentrância: um ciclo em andamento não sobrepõe outro.
   */
  async reconcile(): Promise<ActiveExecutionSweepSummary> {
    const summary: ActiveExecutionSweepSummary = { swept: 0, remainingExpired: 0 }
    if (this.reconciling) return summary
    this.reconciling = true
    try {
      const [result] = await this.pool.query<ResultSetHeader>(
        `DELETE FROM motor_active_executions
          WHERE ${SWEEP_PHASES_SQL}
            AND expires_at <= NOW()`,
      )
      summary.swept = Number((result as { affectedRows?: number } | undefined)?.affectedRows ?? 0)

      const [rows] = await this.pool.query<Array<RowDataPacket & { remaining: number | string }>>(
        `SELECT COUNT(*) AS remaining
           FROM motor_active_executions
          WHERE ${SWEEP_PHASES_SQL}
            AND expires_at <= NOW()`,
      )
      summary.remainingExpired = Number(rows[0]?.remaining ?? 0)

      console.log(JSON.stringify({ event: 'active_execution_sweep', ...summary }))
    } catch (error) {
      // Falha de banco não derruba o processo nem o timer (padrão dos
      // consumidores monitor); o próximo ciclo tenta de novo.
      console.warn('[ActiveExecutionSweeper] Falha no ciclo de limpeza:', error instanceof Error ? error.message : String(error))
    } finally {
      this.reconciling = false
    }
    return summary
  }

  /** Inicia o timer periódico (idempotente; timer não impede o exit do processo). */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
    this.timer.unref()
  }

  /** Para o timer. Duplo stop é seguro. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
