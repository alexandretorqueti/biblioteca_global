/**
 * CrudController — rotas genéricas /api/:resource (PoC §6.2).
 * Registrado por ÚLTIMO no AppModule: rotas específicas (auth, usuarios,
 * projetos) têm precedência; resources reservados são bloqueados no service.
 * Escrita exige perfil admin/gerente/operador; visualizador só lê.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { CrudService, type CrudListParams } from "./crud.service"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class CrudController {
  constructor(@Inject(CrudService) private readonly service: CrudService) {}

  /**
   * Query sem DTO tipado de propósito: chaves além de page/pageSize são
   * filtros por coluna, validados no service contra a tabela.
   */
  @Get(":resource")
  listar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("resource") resource: string,
    @Query() query: Record<string, string>,
  ) {
    const { page, pageSize, ...filters } = query
    const params: CrudListParams = {
      page: page !== undefined ? Number(page) : undefined,
      pageSize: pageSize !== undefined ? Number(pageSize) : undefined,
      filters,
    }
    return this.service.listar(projeto, resource, params)
  }

  @Get(":resource/:id")
  detalhar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("resource") resource: string,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.detalhar(projeto, resource, id)
  }

  @Post(":resource")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  criar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("resource") resource: string,
    @Body() corpo: Record<string, unknown>,
  ) {
    return this.service.criar(projeto, resource, corpo)
  }

  @Put(":resource/:id")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  atualizar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("resource") resource: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() corpo: Record<string, unknown>,
  ) {
    return this.service.atualizar(projeto, resource, id, corpo)
  }

  @Delete(":resource/:id")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  async remover(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("resource") resource: string,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<{ ok: boolean }> {
    await this.service.remover(projeto, resource, id)
    return { ok: true }
  }
}
