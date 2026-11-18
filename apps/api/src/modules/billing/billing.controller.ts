import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common"
import { CurrentProject, CurrentUser } from "../../common/decorators/current.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import type { ProjetoResumo, UsuarioAutenticado } from "@biblioteca-global/shared"
import { BillingService } from "./billing.service"
import { CriarAssinaturaDto } from "./dto/criar-assinatura.dto"

@Controller("billing")
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class BillingController {
  constructor(private readonly service: BillingService) {}

  @Get("planos")
  listarPlanos() {
    return this.service.listarPlanos()
  }

  @Post("assinaturas")
  criarAssinatura(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Body() dto: CriarAssinaturaDto,
  ) {
    return this.service.criarAssinatura(projeto, usuario, dto)
  }
}
