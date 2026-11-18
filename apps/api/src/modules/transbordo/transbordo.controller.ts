import { BadRequestException, Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common"
import { transbordoConfigSchema } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import type { ProjectScope } from "../../common/types"
import { TransbordoService } from "./transbordo.service"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { helpdeskMensagens } from "../../../../../database/schema"
import { Inject } from "@nestjs/common"

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

@Controller("transbordo")
export class TransbordoMagicLinkController {
  constructor(private readonly service: TransbordoService, @Inject(CORE_DB) private readonly db: CoreDb) {}

  @Get("liberar/:token")
  async liberar(@Param("token") token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new BadRequestException("Token de liberação inválido")
    const result = await this.service.liberarPorTokenDetalhes(token)
    if (result.ok && result.sessaoId) {
      await this.db.insert(helpdeskMensagens).values({ sessaoId: result.sessaoId, role: "system", text: "Atendimento humano encerrado. A agente pode retomar a conversa." })
    }
    return result.ok ? { ok: true, message: "Sessão liberada" } : { ok: false, message: "Link inválido, expirado ou já utilizado" }
  }
}
