import { Controller, Get, Query, UseGuards } from "@nestjs/common"
import { GlobalAdminGuard } from "../../common/guards/global-admin.guard"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { Roles } from "../../common/decorators/roles.decorator"
import { AcessoDadosService } from "./acesso-dados.service"

@Controller("admin")
@UseGuards(JwtAuthGuard, ProjectScopeGuard, GlobalAdminGuard, RolesGuard)
export class AcessoDadosController {
  constructor(private readonly service: AcessoDadosService) {}

  @Get("logs-acesso")
  @Roles("admin")
  listar(@Query("limit") limit?: string) {
    return this.service.listar(limit ? Number(limit) : 100)
  }
}
