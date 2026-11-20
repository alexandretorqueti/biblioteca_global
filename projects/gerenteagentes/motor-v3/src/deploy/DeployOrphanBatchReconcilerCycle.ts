/**
 * Ciclo do reconciliador de batches órfãos de deploy (task-p2-1092/1093,
 * incidente 19/11): endurecimento do timer de 5 min que antes rodava
 * requestReconciliation + reconcileOrphanPendingBatches + enqueuePendingDispatches
 * no MESMO try — a falha da primeira fase (SQL ambíguo em runningBatches)
 * impedia as demais e deixou batches zumbis em 'running' por ~1h15 em silêncio.
 *
 * Regras deste ciclo:
 * - cada fase tem try/catch próprio: a falha de uma nunca impede as outras;
 * - paridade com o comportamento anterior: enqueuePendingDispatches só roda
 *   quando reconcileOrphanPendingBatches reportou cleaned > 0;
 * - contador em memória de ciclos falhos CONSECUTIVOS (reset em ciclo
 *   totalmente bem-sucedido); ao atingir N falhas seguidas
 *   (MOTOR_DEPLOY_RECONCILER_ALERT_AFTER_FAILURES, padrão 3) envia alerta
 *   Telegram (TelegramDlqAlertSender, TELEGRAM_BOT_TOKEN/TELEGRAM_DLQ_CHAT_ID)
 *   com cooldown para não spamar a cada ciclo;
 * - logs estruturados: deploy_orphan_pending_batches_cycle_failed (mantido,
 *   por ciclo com falha) + deploy_orphan_pending_batches_reconciliation_failed
 *   (por fase que falhou, com o nome da fase).
 */

/** Superfície do DeployConsumer usada pelo ciclo (injetável para testes). */
export interface DeployOrphanCycleConsumer {
  requestReconciliation(): Promise<unknown>
  reconcileOrphanPendingBatches(): Promise<number>
  enqueuePendingDispatches(): Promise<unknown>
}

export interface DeployOrphanCycleAlertSender {
  send(summary: string): Promise<void>
}

export interface DeployOrphanBatchReconcilerCycleOptions {
  /** Alerta após N ciclos falhos consecutivos (padrão 3; <=0 desativa o alerta). */
  alertAfterFailures?: number
  /** Cooldown entre alertas em minutos (padrão 60). */
  alertCooldownMinutes?: number
  alertSender?: DeployOrphanCycleAlertSender
  /** Relógio injetável (testes). */
  now?: () => number
  /** Log de evento estruturado (padrão: console.error com JSON). */
  logEvent?: (eventName: string, payload: Record<string, unknown>) => void
}

export interface DeployOrphanCycleResult {
  ok: boolean
  cleaned: number
  failedPhases: string[]
}

export type DeployOrphanReconcilerPhase = 'request_reconciliation' | 'reconcile_orphan_pending_batches' | 'enqueue_pending_dispatches'

export interface DeployOrphanReconcilerHealth {
  consecutiveFailedCycles: number
  totalFailedCycles: number
  lastFailedPhase: string | null
  lastCycleError: string | null
  lastCycleAt: string | null
  lastAlertAt: string | null
}

const DEFAULT_ALERT_AFTER_FAILURES = 3
const DEFAULT_ALERT_COOLDOWN_MINUTES = 60

export class DeployOrphanBatchReconcilerCycle {
  private consecutiveFailedCycles = 0
  private totalFailedCycles = 0
  private lastFailedPhase: string | null = null
  private lastCycleError: string | null = null
  private lastCycleAtMs: number | null = null
  private lastAlertAtMs = 0

  private readonly alertAfterFailures: number
  private readonly alertCooldownMs: number
  private readonly alertSender: DeployOrphanCycleAlertSender | undefined
  private readonly now: () => number
  private readonly logEvent: (eventName: string, payload: Record<string, unknown>) => void

  constructor(
    private readonly consumer: DeployOrphanCycleConsumer,
    options: DeployOrphanBatchReconcilerCycleOptions = {},
  ) {
    this.alertAfterFailures = Number.isFinite(options.alertAfterFailures)
      ? Number(options.alertAfterFailures)
      : DEFAULT_ALERT_AFTER_FAILURES
    const cooldown = Number(options.alertCooldownMinutes)
    this.alertCooldownMs = (Number.isFinite(cooldown) && cooldown > 0 ? cooldown : DEFAULT_ALERT_COOLDOWN_MINUTES) * 60_000
    this.alertSender = options.alertSender
    this.now = options.now ?? (() => Date.now())
    this.logEvent = options.logEvent ?? ((eventName, payload) => {
      console.error(JSON.stringify({ event: eventName, ...payload }))
    })
  }

  /**
   * Executa UMA iteração do ciclo. Nunca lança: falhas de fase ficam no
   * resultado e nos logs. Retorna cleaned para paridade com o timer antigo.
   */
  async runCycle(): Promise<DeployOrphanCycleResult> {
    const failedPhases: string[] = []
    const errors: string[] = []
    let cleaned = 0

    const failPhase = (phase: DeployOrphanReconcilerPhase, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      failedPhases.push(phase)
      errors.push(`${phase}: ${message}`)
      // Evento por fase (novo): identifica exatamente o que quebrou no ciclo.
      this.logEvent('deploy_orphan_pending_batches_reconciliation_failed', { phase, error: message })
    }

    // Fase 1: reemite pedidos de reconciliação dos batches running.
    try {
      await this.consumer.requestReconciliation()
    } catch (error) {
      failPhase('request_reconciliation', error)
    }

    // Fase 2: limpa batches pending órfãos (independente da fase 1).
    try {
      cleaned = await this.consumer.reconcileOrphanPendingBatches()
    } catch (error) {
      // cleaned permanece 0 (o await quebrou antes da atribuição).
      failPhase('reconcile_orphan_pending_batches', error)
    }

    // Fase 3: só com cleaned > 0 (paridade com o timer anterior); a fase 2
    // falha não impede esta quando há cleaned conhecido — e vice-versa.
    if (cleaned > 0) {
      try {
        await this.consumer.enqueuePendingDispatches()
      } catch (error) {
        failPhase('enqueue_pending_dispatches', error)
      }
    }

    this.lastCycleAtMs = this.now()
    if (failedPhases.length > 0) {
      this.consecutiveFailedCycles += 1
      this.totalFailedCycles += 1
      this.lastFailedPhase = failedPhases[failedPhases.length - 1] ?? null
      this.lastCycleError = errors.join(' | ')
      // Evento do ciclo mantido (mesmo nome/shape do comportamento anterior).
      this.logEvent('deploy_orphan_pending_batches_cycle_failed', {
        error: this.lastCycleError,
        failedPhases,
        consecutiveFailedCycles: this.consecutiveFailedCycles,
      })
      await this.maybeAlert()
    } else {
      this.consecutiveFailedCycles = 0
      this.lastCycleError = null
      this.lastFailedPhase = null
    }

    return { ok: failedPhases.length === 0, cleaned, failedPhases }
  }

  /** Contagem para /api/motor/status (observabilidade do ciclo de 5 min). */
  getHealth(): DeployOrphanReconcilerHealth {
    return {
      consecutiveFailedCycles: this.consecutiveFailedCycles,
      totalFailedCycles: this.totalFailedCycles,
      lastFailedPhase: this.lastFailedPhase,
      lastCycleError: this.lastCycleError,
      lastCycleAt: this.lastCycleAtMs === null ? null : new Date(this.lastCycleAtMs).toISOString(),
      lastAlertAt: this.lastAlertAtMs === 0 ? null : new Date(this.lastAlertAtMs).toISOString(),
    }
  }

  private async maybeAlert(): Promise<void> {
    if (this.alertAfterFailures <= 0 || !this.alertSender) return
    if (this.consecutiveFailedCycles < this.alertAfterFailures) return
    // lastAlertAtMs === 0 significa "nunca alertou" → não bloqueia.
    if (this.lastAlertAtMs !== 0 && this.now() - this.lastAlertAtMs < this.alertCooldownMs) return
    try {
      await this.alertSender.send(
        `⚠️ Ciclo deployOrphanBatchReconciler falhou ${this.consecutiveFailedCycles}x seguidas. ` +
        `Fases com falha: ${this.lastFailedPhase ?? '?'}. Último erro: ${this.lastCycleError ?? '?'}. ` +
        `Batches em 'running' podem estar zumbis (reconciliação/dispatch parado) — ` +
        `investigar deploy_orphan_pending_batches_reconciliation_failed nos logs.`,
      )
      this.lastAlertAtMs = this.now()
    } catch (error) {
      console.error(`[DeployOrphanBatchReconcilerCycle] alerta falhou: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
