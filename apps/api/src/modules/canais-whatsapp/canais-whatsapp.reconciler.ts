import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common"
import type { BillingAlertSender } from "../billing/billing-reconciler"
import { CANAIS_WHATSAPP_REPOSITORY, type CanaisWhatsappRepository } from "./canais-whatsapp.repository"
import { CANAIS_WHATSAPP_BRIDGE, type CanaisWhatsappBridge } from "./canais-whatsapp.types"

export interface CanaisWhatsappReconcilerOptions { intervalMs?: number }

@Injectable()
export class CanaisWhatsappReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CanaisWhatsappReconciler.name)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly intervalMs: number

  constructor(
    @Inject(CANAIS_WHATSAPP_REPOSITORY) private readonly repository: CanaisWhatsappRepository,
    @Inject(CANAIS_WHATSAPP_BRIDGE) private readonly bridge: CanaisWhatsappBridge,
    @Inject("BILLING_ALERT_SENDER") private readonly alert: BillingAlertSender,
    @Optional() options: CanaisWhatsappReconcilerOptions = {},
  ) { this.intervalMs = options.intervalMs ?? 60_000 }

  onModuleInit(): void {
    if (this.timer) return
    void this.reconcile()
    this.timer = setInterval(() => { void this.reconcile() }, this.intervalMs)
    this.timer.unref()
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  async reconcile(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const remote = await this.bridge.status()
      const byAccount = new Map(remote.map((item) => [item.accountId, item]))
      for (const row of await this.repository.list()) {
        const status = byAccount.get(row.accountId)
        const connected = status?.connected === true
        if (status) await this.repository.update(row.id, { numero: status.phone, ...(status.agentId ? { agentId: status.agentId } : {}), ultimoStatusEm: new Date() })
        if (row.estado === "ativo" && !connected) {
          await this.repository.update(row.id, { estado: "expirado", ultimoStatusEm: new Date() })
          await this.alert.send(`🚨 WhatsApp expirado: tenant=${row.tenantSlug}, conta=${row.accountId}.`)
        }
      }
    } catch (error) { this.logger.warn(`falha reconciliando canais WhatsApp: ${error instanceof Error ? error.message : String(error)}`) }
    finally { this.running = false }
  }
}
