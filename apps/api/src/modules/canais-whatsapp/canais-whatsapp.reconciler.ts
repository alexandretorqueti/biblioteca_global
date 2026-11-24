import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common"
import type { BillingAlertSender } from "../billing/billing-reconciler"
import { CANAIS_WHATSAPP_REPOSITORY, type CanaisWhatsappRepository } from "./canais-whatsapp.repository"
import { CANAIS_WHATSAPP_BRIDGE, type CanaisWhatsappBridge } from "./canais-whatsapp.types"

export interface CanaisWhatsappReconcilerOptions {
  intervalMs?: number
  enabled?: boolean
  now?: () => Date
}

/** Teto do backoff exponencial em falha do bridge: 15 minutos. */
const BACKOFF_MAX_MS = 900_000

@Injectable()
export class CanaisWhatsappReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CanaisWhatsappReconciler.name)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly intervalMs: number
  private readonly enabled: boolean
  private readonly now: () => Date
  private falhasConsecutivas = 0
  private nextAttemptAt: number | null = null

  constructor(
    @Inject(CANAIS_WHATSAPP_REPOSITORY) private readonly repository: CanaisWhatsappRepository,
    @Inject(CANAIS_WHATSAPP_BRIDGE) private readonly bridge: CanaisWhatsappBridge,
    @Inject("BILLING_ALERT_SENDER") private readonly alert: BillingAlertSender,
    @Optional() options: CanaisWhatsappReconcilerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 60_000
    this.enabled = options.enabled ?? process.env.CANAIS_WHATSAPP_RECONCILE !== "0"
    this.now = options.now ?? (() => new Date())
  }

  onModuleInit(): void {
    if (this.timer || !this.enabled) return
    void this.reconcile()
    this.timer = setInterval(() => { void this.reconcile() }, this.intervalMs)
    this.timer.unref()
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  async reconcile(): Promise<void> {
    if (this.running || !this.enabled) return
    if (this.nextAttemptAt !== null && this.now().getTime() < this.nextAttemptAt) return
    this.running = true
    try {
      const rows = await this.repository.list()
      if (rows.length === 0) {
        this.logger.debug("nenhum canal WhatsApp cadastrado; nada a reconciliar")
        this.falhasConsecutivas = 0
        this.nextAttemptAt = null
        return
      }
      const remote = await this.bridge.status()
      const recuperado = this.falhasConsecutivas > 0
      this.falhasConsecutivas = 0
      this.nextAttemptAt = null
      if (recuperado) this.logger.log("reconciliação de canais WhatsApp recuperada")
      const byAccount = new Map(remote.map((item) => [item.accountId, item]))
      for (const row of rows) {
        const status = byAccount.get(row.accountId)
        const connected = status?.connected === true
        if (status) await this.repository.update(row.id, { numero: status.phone, ...(status.agentId ? { agentId: status.agentId } : {}), ultimoStatusEm: new Date() })
        if (row.estado === "ativo" && !connected) {
          await this.repository.update(row.id, { estado: "expirado", ultimoStatusEm: new Date() })
          await this.alert.send(`🚨 WhatsApp expirado: tenant=${row.tenantSlug}, conta=${row.accountId}.`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transicao = this.falhasConsecutivas === 0
      this.nextAttemptAt = this.now().getTime() + Math.min(this.intervalMs * 2 ** this.falhasConsecutivas, BACKOFF_MAX_MS)
      this.falhasConsecutivas += 1
      if (transicao) this.logger.warn(`falha reconciliando canais WhatsApp: ${message}`)
      else this.logger.debug(`falha contínua reconciliando canais WhatsApp (falha ${this.falhasConsecutivas} consecutiva): ${message}`)
    } finally { this.running = false }
  }
}
