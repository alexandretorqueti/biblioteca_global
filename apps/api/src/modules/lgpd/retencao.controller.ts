import { Controller, Post, UseGuards } from "@nestjs/common"
import { GlobalAdminGuard } from "../../common/guards/global-admin.guard"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { Roles } from "../../common/decorators/roles.decorator"
import { RetencaoService } from "./retencao.service"

@Controller("admin")
@UseGuards(JwtAuthGuard, ProjectScopeGuard, GlobalAdminGuard, RolesGuard)
export class RetencaoController {
  constructor(private readonly service: RetencaoService) {}

  @Post("executar-retencao")
  @Roles("admin")
  executar() {
    return this.service.executar()
  }
}
