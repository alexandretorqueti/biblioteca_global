import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common"
import type { UsuarioAutenticado } from "@biblioteca-global/shared"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import {
  BILLING_REPOSITORY,
  type BillingRepository,
} from "./billing.repository"
import { PSP_BILLING_GATEWAY, type PspBillingGateway } from "./psp-billing.gateway"
import type { CriarAssinaturaDto } from "./dto/criar-assinatura.dto"
import type { BillingWebhookEvent } from "./billing.repository"

@Injectable()
export class BillingService {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repository: BillingRepository,
    @Inject(PSP_BILLING_GATEWAY) private readonly gateway: PspBillingGateway,
  ) {}

  listarPlanos(): ReturnType<BillingRepository["listarPlanosAtivos"]> {
    return this.repository.listarPlanosAtivos()
  }

  async criarAssinatura(
    projeto: ProjetoResumo,
    usuario: UsuarioAutenticado,
    dto: CriarAssinaturaDto,
  ) {
    const plano = await this.repository.buscarPlanoAtivo(dto.planoSlug)
    if (!plano) throw new NotFoundException("Plano ativo não encontrado")
    if (dto.ciclo !== undefined && dto.ciclo !== plano.ciclo) {
      throw new BadRequestException("Ciclo incompatível com o plano")
    }
    const email = usuario.email?.trim()
    if (!email) throw new BadRequestException("Usuário sem e-mail para cobrança")

    const assinatura = await this.repository.criarAssinatura({
      tenantSlug: projeto.slug,
      planoProdutoId: plano.id,
      ciclo: plano.ciclo,
    })
    const customer = await this.gateway.createCustomer({
      externalReference: `tenant:${projeto.slug}`,
      name: usuario.nome,
      email,
    })
    const checkout = await this.gateway.createSubscription({
      externalReference: `assinatura:${assinatura.id}`,
      customerId: customer.id,
      planName: plano.nome,
      amountInCents: plano.precoCentavos,
      currency: plano.moeda,
      cycle: plano.ciclo,
      payerEmail: email,
      checkoutSuccessUrl: dto.checkoutSuccessUrl,
      checkoutFailureUrl: dto.checkoutFailureUrl,
      checkoutPendingUrl: dto.checkoutPendingUrl,
    })
    await this.repository.vincularPsp(assinatura.id, customer.id, checkout.subscriptionId)
    return {
      id: assinatura.id,
      status: assinatura.status,
      checkoutUrl: checkout.checkoutUrl,
      pspSubscriptionId: checkout.subscriptionId,
    }
  }

  webhookDataId(payload: unknown): string | undefined {
    if (!this.isRecord(payload)) return undefined
    const data = this.isRecord(payload.data) ? payload.data : undefined
    const id = data?.id ?? payload.id
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined
  }

  async receberWebhook(payload: unknown): Promise<{ duplicate: boolean }> {
    if (!this.isRecord(payload)) throw new BadRequestException("Payload inválido")
    const tipo = this.webhookType(payload)
    const dataId = this.webhookDataId(payload)
    if (!tipo || !dataId) throw new BadRequestException("Evento sem tipo ou identificador")
    const result = await this.repository.inserirWebhook({
      dedupeKey: `${tipo}:${dataId}`,
      tipo,
      payload,
    })
    if (!result.duplicate) void this.processarWebhook(result.event).catch(() => undefined)
    return { duplicate: result.duplicate }
  }

  async processarWebhook(event: BillingWebhookEvent): Promise<void> {
    const claimed = await this.repository.claimWebhook(event.id)
    if (!claimed) return
    try {
      if (this.isApproval(claimed.tipo, claimed.payload) || claimed.tipo.startsWith("subscription.")) {
        const subscriptionId = this.subscriptionId(claimed.payload, claimed.tipo)
        if (subscriptionId) await this.repository.processarAprovacao({ subscriptionId, payload: claimed.payload })
      }
      await this.repository.marcarWebhookConcluido(claimed.id)
    } catch (error) {
      await this.repository.marcarWebhookFalho(claimed.id, error instanceof Error ? error.message : String(error), new Date(Date.now() + 60_000))
      throw error
    }
  }

  subscriptionIdFromPayload(payload: unknown, tipo: string): string | undefined {
    return this.subscriptionId(payload, tipo)
  }

  /** Ponto de reconciliação: o scheduler pode chamar este método após restart. */
  async reconciliarWebhooks(events: BillingWebhookEvent[]): Promise<void> {
    for (const event of events) await this.processarWebhook(event)
  }

  private webhookType(payload: Record<string, unknown>): string | undefined {
    const value = payload.type ?? payload.action
    return typeof value === "string" ? value : undefined
  }

  private subscriptionId(payload: unknown, tipo: string): string | undefined {
    if (!this.isRecord(payload)) return undefined
    const data = this.isRecord(payload.data) ? payload.data : undefined
    const metadata = this.isRecord(payload.metadata) ? payload.metadata : data && this.isRecord(data.metadata) ? data.metadata : undefined
    const direct = metadata?.subscription_id ?? payload.subscription_id
    if (typeof direct === "string" || typeof direct === "number") return String(direct)
    if (tipo.startsWith("subscription.") && (typeof data?.id === "string" || typeof data?.id === "number")) {
      return String(data.id)
    }
    const reference = payload.external_reference ?? data?.external_reference
    if (typeof reference === "string" && reference.startsWith("assinatura:")) return reference.slice("assinatura:".length)
    return undefined
  }

  private isApproval(tipo: string, payload: unknown): boolean {
    if (tipo === "payment.approved") return true
    if (tipo !== "payment.updated" || !this.isRecord(payload)) return false
    const data = this.isRecord(payload.data) ? payload.data : undefined
    return payload.status === "approved" || data?.status === "approved"
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }
}
