import { BadRequestException, Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common"
import { CurrentProject } from "../../common/decorators/current.decorator"
import type { ProjectScope } from "../../common/types"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { CanaisWhatsappService } from "./canais-whatsapp.service"

@Controller("canais/whatsapp")
@UseGuards(JwtAuthGuard, ProjectScopeGuard, RolesGuard)
@Roles("admin")
export class CanaisWhatsappController {
  constructor(private readonly service: CanaisWhatsappService) {}

  @Post("tenants/:slug/pareamento")
  iniciar(@Param("slug") slug: string, @CurrentProject() projeto: ProjectScope["projeto"]) {
    this.assertTenantScope(slug, projeto.slug)
    return this.service.iniciarPareamento(slug)
  }

  @Get("tenants/:slug/pareamento")
  confirmar(@Param("slug") slug: string, @CurrentProject() projeto: ProjectScope["projeto"]) {
    this.assertTenantScope(slug, projeto.slug)
    return this.service.confirmarPareamento(slug)
  }

  @Get("vinculos")
  listar() { return this.service.listar() }

  @Delete("vinculos/:id")
  remover(@Param("id", ParseIntPipe) id: number) { return this.service.remover(id) }

  private assertTenantScope(routeSlug: string, tokenSlug: string): void {
    if (routeSlug !== tokenSlug) throw new BadRequestException("Tenant não pertence ao projeto autenticado")
  }
}
