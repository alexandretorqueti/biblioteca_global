import { Controller, Get, Query, UseGuards } from "@nestjs/common"
import { Roles } from "../../common/decorators/roles.decorator"
import { GlobalAdminGuard } from "../../common/guards/global-admin.guard"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { ListLogsLoginQueryDto } from "./dto/list-logs-login-query.dto"
import { LogsLoginService } from "./logs-login.service"

@Controller("logs-login")
@UseGuards(JwtAuthGuard, ProjectScopeGuard, GlobalAdminGuard, RolesGuard)
@Roles("admin")
export class LogsLoginController {
  constructor(private readonly service: LogsLoginService) {}

  @Get()
  listar(@Query() query: ListLogsLoginQueryDto) {
    return this.service.listar(query)
  }
}
