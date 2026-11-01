import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

interface OrphanRow extends RowDataPacket {
  id: number
  status: string
  worker_id: string | null
  claimed_at: Date | string | null
  lease_expires_at: Date | string | null
}

export interface GenerationClaimReconcilerConfig {
  /** Ciclo periódico (padrão 5 min — padrão AnalysisClaimReconciler/TestGateJobReconciler). */
  intervalMs?: number
  /**
   * Janela para considerar órfã uma geracao 'running' SEM lease
   * (lease_expires_at IS NULL): claimed_at mais antigo que staleMinutes.
   * Cobre linhas em 'running' criadas por fluxo externo (ex.: decisao=revise
   * do endpoint de aprovação devolve a geracao para 'running' com feedback e
   * sem claim — o reconciliador as normaliza para 'pending', de onde o
   * ProjectGenerationWorker retoma a rodada com o histórico/feedback).
   */
  staleMinutes?: number
}

/**
 * GenerationClaimReconciler — recuperação de claims órfãos de
 * `geracoes_projeto` (Geração Macro, docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md
 * §3.1; padrão AnalysisClaimReconciler / TestGateJobReconciler).
 *
 * Regra: geracao 'running' com lease vencido E sem worker vivo → 'pending'.
 * Um worker vivo renova o lease a cada ttl/3, portanto lease vencido implica
 * worker morto (crash/deploy no meio da sessão).
 *
 * Premissa de instância única (docs/CONCORRENCIA-E-LOCKS-MOTOR.md): no BOOT
 * não existe worker de geração vivo neste processo — qualquer 'running'
 * remanescente é órfão e é liberado imediatamente
 * (`treatAllRunningAsOrphans`), sem esperar o lease vencer. No ciclo
 * periódico, apenas leases vencidos (ou 'running' sem claim há mais de
 * staleMinutes) são tocados, para não roubar gerações em andamento.
 *
 * Idempotente: o UPDATE é condicionado a `status='running'`; passagem
 * repetida sobre a mesma linha não tem efeito. Erros não propagam
 * (barreira, como nos demais reconciliadores).
 */
export class GenerationClaimReconciler {
  private timer: NodeJS.Timeout | null = null
  private readonly intervalMs: number
  private readonly staleMinutes: number

  constructor(
    private readonly pool: Pool,
    config: GenerationClaimReconcilerConfig = {},
  ) {
    this.intervalMs = config.intervalMs ?? Number(process.env.MOTOR_GENERATION_RECONCILE_INTERVAL_MS || 300_000)
    this.staleMinutes = config.staleMinutes ?? 15
  }

  /** Uma passagem. Retorna os ids de gerações devolvidas para 'pending'. */
  async reconcile(options: { treatAllRunningAsOrphans?: boolean } = {}): Promise<number[]> {
    try {
      const bootMode = options.treatAllRunningAsOrphans === true
      const [rows] = bootMode
        ? await this.pool.query<OrphanRow[]>(
            `SELECT id, status, worker_id, claimed_at, lease_expires_at
               FROM geracoes_projeto
              WHERE status = 'running'
              ORDER BY id ASC`,
          )
        : await this.pool.query<OrphanRow[]>(
            `SELECT id, status, worker_id, claimed_at, lease_expires_at
               FROM geracoes_projeto
              WHERE status = 'running'
                AND (
                  (lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3))
                  OR (lease_expires_at IS NULL AND claimed_at IS NOT NULL AND claimed_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE))
                  OR (lease_expires_at IS NULL AND claimed_at IS NULL)
                )
              ORDER BY id ASC`,
            [this.staleMinutes],
          )

      const recovered: number[] = []
      for (const row of rows) {
        const [result] = await this.pool.query<ResultSetHeader>(
          `UPDATE geracoes_projeto
              SET status = 'pending', worker_id = NULL, claimed_at = NULL,
                  lease_expires_at = NULL, updated_at = NOW()
            WHERE id = ? AND status = 'running'`,
          [Number(row.id)],
        )
        if (result.affectedRows > 0) {
          recovered.push(Number(row.id))
          console.warn(`[GenerationClaimReconciler] geracao órfã recuperada: id=${row.id} worker=${row.worker_id ?? '(sem worker)'} claimed_at=${row.claimed_at ?? '(sem claim)'} lease=${row.lease_expires_at ?? '(sem lease)'} ${bootMode ? '(boot: instância única)' : '(lease vencido)'}`)
        }
      }
      return recovered
    } catch (error) {
      console.error('[GenerationClaimReconciler] falha na reconciliação:', error instanceof Error ? error.message : error)
      return []
    }
  }

  start(): void {
    if (this.timer) return
    // `reconcile` já contém barreira de erro; o void explícito evita unhandled rejection.
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
