import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common"
import { Public } from "../../common/decorators/public.decorator"
import { AnexarDocumentoDto } from "./dto/anexar-documento.dto"
import { AnotarNegocioDto } from "./dto/anotar-negocio.dto"
import { CriarPedidoDto } from "./dto/criar-pedido.dto"
import { VendasService } from "./vendas.service"
import { AceitePedidoDto } from "./dto/aceite-pedido.dto"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { Roles } from "../../common/decorators/roles.decorator"
import { PROVISIONAMENTO_REPOSITORY, type ProvisionamentoRepository } from "./provisionamento.repository"
import type { BillingAlertSender } from "../billing/billing-reconciler"

@Controller("vendas")
export class VendasController {
  constructor(
    private readonly service: VendasService,
    @Inject(PROVISIONAMENTO_REPOSITORY) private readonly repository: ProvisionamentoRepository,
    @Inject("BILLING_ALERT_SENDER") private readonly alert: BillingAlertSender,
  ) {}

  @Public()
  @Get("planos")
  listarPlanos() {
    return this.service.listarPlanos()
  }

  @Public()
  @Post("pedido")
  criarPedido(@Body() dto: CriarPedidoDto) {
    return this.service.criarPedido(dto)
  }

  @Public()
  @Post("negocio")
  anotarNegocio(@Body() dto: AnotarNegocioDto) {
    return this.service.anotarNegocio(dto)
  }

  @Public()
  @Post("negocio/documento")
  anexarDocumento(@Body() dto: AnexarDocumentoDto) {
    return this.service.anexarDocumento(dto)
  }

  @UseGuards(JwtAuthGuard, ProjectScopeGuard, RolesGuard)
  @Roles("admin")
  @Post("pedidos/:id/aceite")
  async decidirAceite(@Param("id") id: string, @Body() dto: AceitePedidoDto) {
    const pedidoId = Number(id)
    if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0) throw new BadRequestException("id de pedido inválido")
    if (dto.decisao === "aprovar") {
      const ok = await this.repository.aprovarAceite(pedidoId)
      if (!ok) throw new NotFoundException("Pedido não está aguardando aceite")
      return { ok: true, status: "aprovado" }
    }
    const result = await this.repository.rejeitarAceite(pedidoId)
    if (!result) throw new NotFoundException("Pedido não está aguardando aceite")
    await this.alert.send(`🔴 Pedido ${pedidoId} rejeitado no aceite manual. Assinatura=${result.assinaturaId} marcada como reembolsável.`)
    return { ok: true, status: "rejeitado", reembolsavel: true }
  }
}
