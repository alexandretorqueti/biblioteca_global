import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common"
import type { UsuarioAutenticado } from "@biblioteca-global/shared"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import {
  BILLING_REPOSITORY,
  type BillingRepository,
} from "./billing.repository"
import { PSP_BILLING_GATEWAY, type PspBillingGateway } from "./psp-billing.gateway"
import type { CriarAssinaturaDto } from "./dto/criar-assinatura.dto"

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
}
