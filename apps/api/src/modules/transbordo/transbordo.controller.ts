import { BadRequestException, Body, Controller, Param, Put, UseGuards } from "@nestjs/common"
import { transbordoConfigSchema } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import type { ProjectScope } from "../../common/types"
import { TransbordoService } from "./transbordo.service"

@Controller("transbordo")
@UseGuards(JwtAuthGuard, ProjectScopeGuard, RolesGuard)
@Roles("admin")
export class TransbordoController {
  constructor(private readonly service: TransbordoService) {}

  @Put("config/:tenantSlug")
  async atualizarConfig(
    @Param("tenantSlug") tenantSlug: string,
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Body() body: unknown,
  ) {
    if (tenantSlug !== projeto.slug) {
      throw new BadRequestException("tenantSlug não pertence ao projeto autenticado")
    }
    const parsed = transbordoConfigSchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({ message: "Configuração de transbordo inválida", issues: parsed.error.issues })
    }
    return this.service.salvarConfig(projeto.slug, parsed.data)
  }
}
