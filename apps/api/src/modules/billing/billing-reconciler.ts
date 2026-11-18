import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common"
import { EnvService } from "../../config/env.service"
import { PSP_BILLING_GATEWAY, type PspBillingGateway } from "./psp-billing.gateway"
import { BILLING_REPOSITORY, type BillingRepository } from "./billing.repository"
import { BillingService } from "./billing.service"

export interface BillingAlertSender { send(text: string): Promise<void> }

export interface BillingReconcilerOptions {
  intervalMs?: number
  retryLimit?: number
  maxAttempts?: number
  pendingAgeMs?: number
  batchSize?: number
  now?: () => Date
}

export class BillingTelegramAlertSender implements BillingAlertSender {
  private warnedMissingConfig = false
  constructor(private readonly botToken?: string, private readonly chatId?: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(text: string): Promise<void> {
    if (!this.botToken || !this.chatId) {
      if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true
        console.warn("[BillingReconciler] Telegram não configurado (TELEGRAM_BOT_TOKEN/TELEGRAM_DLQ_CHAT_ID); alerta só em log.")
      }
      console.warn(`[BillingReconciler] alerta (log-only): ${text}`)
      return
    }
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    })
    if (!response.ok) throw new Error(`Telegram respondeu ${response.status}`)
  }
}

@Injectable()
export class BillingReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingReconciler.name)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly options: Required<BillingReconcilerOptions>

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repository: BillingRepository,
    @Inject(PSP_BILLING_GATEWAY) private readonly gateway: PspBillingGateway,
    private readonly service: BillingService,
    @Inject("BILLING_ALERT_SENDER")
    private readonly alertSender: BillingAlertSender,
    @Optional() private readonly optionsInput: BillingReconcilerOptions = {},
  ) {
    const options = optionsInput
    this.options = {
      intervalMs: options.intervalMs ?? 300_000,
      retryLimit: options.retryLimit ?? 50,
      maxAttempts: options.maxAttempts ?? 5,
      pendingAgeMs: options.pendingAgeMs ?? 15 * 60_000,
      batchSize: options.batchSize ?? 50,
      now: options.now ?? (() => new Date()),
    }
  }

  onModuleInit(): void {
    if (this.timer) return
    void this.reconcile()
    this.timer = setInterval(() => { void this.reconcile() }, this.options.intervalMs)
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async reconcile(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.retryWebhooks()
      await this.reconcilePendingSubscriptions()
    } catch (error) {
      this.logger.error(`falha no ciclo: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.running = false
    }
  }

  private async retryWebhooks(): Promise<void> {
    const now = this.options.now()
    const events = await this.repository.listarWebhooksParaRetry(now, this.options.retryLimit)
    for (const event of events) {
      try {
        await this.service.processarWebhook(event)
      } catch (error) {
        try {
          const attempts = event.tentativas + 1
          const message = error instanceof Error ? error.message : String(error)
          if (attempts >= this.options.maxAttempts) {
            await this.repository.marcarWebhookDead(event.id)
            const subscriptionId = this.service.subscriptionIdFromPayload(event.payload, event.tipo)
            if (subscriptionId) {
              await this.repository.marcarAssinaturaReembolsavel(subscriptionId)
            }
            await this.alertSender.send(`🚨 Billing webhook morto: evento ${event.id} (${event.tipo}), tentativas=${attempts}. Assinatura=${subscriptionId ?? "desconhecida"}. Caso marcado como reembolsável.`)
          } else {
            const delayMs = 60_000 * 2 ** Math.max(0, attempts - 1)
            await this.repository.marcarWebhookFalho(event.id, message, new Date(now.getTime() + delayMs))
          }
        } catch (handlingError) {
          this.logger.error(`falha tratando evento ${event.id}: ${handlingError instanceof Error ? handlingError.message : String(handlingError)}`)
        }
      }
    }
  }

  private async reconcilePendingSubscriptions(): Promise<void> {
    const cutoff = new Date(this.options.now().getTime() - this.options.pendingAgeMs)
    const subscriptions = await this.repository.listarAssinaturasPendentesAntigas(cutoff, this.options.batchSize)
    for (const subscription of subscriptions) {
      if (!subscription.pspSubscriptionId) continue
      try {
        const state = await this.gateway.getSubscription(subscription.pspSubscriptionId)
        await this.repository.sincronizarAssinaturaPsp({ subscriptionId: state.id, status: state.status, payload: { source: "billing_reconciliation", state } })
      } catch (error) {
        this.logger.warn(`falha reconciliando assinatura ${subscription.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

export function createBillingAlertSender(env: EnvService): BillingAlertSender {
  return new BillingTelegramAlertSender(env.telegramBotToken, env.telegramDlqChatId)
}
