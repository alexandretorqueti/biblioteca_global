import { BadRequestException, Body, Controller, Get, Header, Param, ParseIntPipe, Post, Put, Query, UseGuards } from "@nestjs/common"
import { tenantConversaIngestaoSchema, tenantConversasFiltrosSchema, tenantLeadIngestaoSchema, tenantLeadsFiltrosSchema } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { PainelTenantService } from "./painel-tenant.service"
import { TenantIngestGuard } from "../provision/provision.guard"

function parsed<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } } }, value: unknown): T { const p = schema.safeParse(value); if (!p.success) throw new BadRequestException({ message: "Parâmetros inválidos", issues: p.error.issues }); return p.data }

@Controller("painel-tenant")
@UseGuards(JwtAuthGuard, ProjectScopeGuard, RolesGuard)
@Roles("admin")
export class PainelTenantController {
  constructor(private readonly service: PainelTenantService) {}
  private async tenant(slug: string, projeto: ProjetoResumo) { return this.service.tenantDoProjeto(slug, projeto.slug) }
  @Get(":slug/conversas") async conversas(@Param("slug") slug: string, @CurrentProject() projeto: ProjetoResumo, @Query() q: Record<string, string>) { const t = await this.tenant(slug, projeto); return this.service.conversas(t.id, parsed(tenantConversasFiltrosSchema, q)) }
  @Get(":slug/conversas/:id/mensagens") async mensagens(@Param("slug") slug: string, @Param("id", ParseIntPipe) id: number, @CurrentProject() projeto: ProjetoResumo) { const t = await this.tenant(slug, projeto); return this.service.historico(t.id, id) }
  @Get(":slug/leads") async leads(@Param("slug") slug: string, @CurrentProject() projeto: ProjetoResumo, @Query() q: Record<string, string>) { const t = await this.tenant(slug, projeto); return this.service.leads(t.id, parsed(tenantLeadsFiltrosSchema, q)) }
  @Get(":slug/leads/export") @Header("Content-Type", "text/csv; charset=utf-8") async exportar(@Param("slug") slug: string, @CurrentProject() projeto: ProjetoResumo, @Query() q: Record<string, string>) { const t = await this.tenant(slug, projeto); return this.service.csv(t.id, parsed(tenantLeadsFiltrosSchema, q)) }
  @Get(":slug/metricas") async metricas(@Param("slug") slug: string, @CurrentProject() projeto: ProjetoResumo, @Query("mes") mes?: string) { const t = await this.tenant(slug, projeto); return this.service.metricas(t.id, slug, mes) }
  @Get(":slug/config") async config(@Param("slug") slug: string, @CurrentProject() projeto: ProjetoResumo) { const t = await this.tenant(slug, projeto); return this.service.obterConfig(t.id, slug) }
  @Put(":slug/config") async putConfig(@Param("slug") slug: string, @CurrentProject() projeto: ProjetoResumo, @Body() body: unknown) { const t = await this.tenant(slug, projeto); return this.service.salvarConfig(t.id, slug, body) }
}

@Controller("painel-tenant/ingest")
@UseGuards(TenantIngestGuard)
export class PainelTenantIngestController {
  constructor(private readonly service: PainelTenantService) {}
  private async tenant(slug: string) { return this.service.tenantPorSlug(slug) }
  @Post(":slug/conversa") async conversa(@Param("slug") slug: string, @Body() body: unknown) { const p = parsed(tenantConversaIngestaoSchema, body); return this.service.ingestirConversa((await this.tenant(slug)).id, p as unknown as Record<string, unknown>) }
  @Post(":slug/lead") async lead(@Param("slug") slug: string, @Body() body: unknown) { const p = parsed(tenantLeadIngestaoSchema, body); return this.service.ingestirLead((await this.tenant(slug)).id, p as unknown as Record<string, unknown>) }
}
