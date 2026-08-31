/**
 * UsuariosController — CRUD com escopo automático pelo projeto do token.
 * Rotas globais (?projetoId= e /vincular) são exclusivas do projeto
 * biblioteca-global (PoC §8).
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
import { CurrentProject, CurrentUser } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { GlobalAdminGuard } from "../../common/guards/global-admin.guard"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import type { ProjectScope } from "../../common/types"
// DTOs com import de VALOR (o ValidationPipe resolve a classe em runtime).
import { CreateUsuarioDto } from "./dto/create-usuario.dto"
import { ListUsuariosQueryDto } from "./dto/list-usuarios-query.dto"
import { UpdateUsuarioDto } from "./dto/update-usuario.dto"
import { VincularDto } from "./dto/vincular.dto"
import { UsuariosService } from "./usuarios.service"

function escopoDe(
  usuario: ProjectScope["usuario"],
  projeto: ProjectScope["projeto"],
): ProjectScope {
  return { usuario, projeto }
}

@Controller("usuarios")
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class UsuariosController {
  constructor(
    @Inject(UsuariosService) private readonly service: UsuariosService,
  ) {}

  @Get()
  listar(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Query() query: ListUsuariosQueryDto,
  ) {
    return this.service.listar(escopoDe(usuario, projeto), query)
  }

  @Get(":id")
  detalhar(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.detalhar(escopoDe(usuario, projeto), id)
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente")
  criar(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Body() dto: CreateUsuarioDto,
  ) {
    return this.service.criar(escopoDe(usuario, projeto), dto)
  }

  /**
   * /vincular ANTES de :id — rotas literais mais específicas primeiro.
   * Exclusivo do admin global (PoC §8).
   */
  @Put(":id/vincular")
  @UseGuards(GlobalAdminGuard, RolesGuard)
  @Roles("admin")
  vincular(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: VincularDto,
  ) {
    return this.service.vincular(escopoDe(usuario, projeto), id, dto)
  }

  @Put(":id")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente")
  editar(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateUsuarioDto,
  ) {
    return this.service.editar(escopoDe(usuario, projeto), id, dto)
  }

  @Delete(":id")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente")
  async excluir(
    @CurrentUser() usuario: ProjectScope["usuario"],
    @CurrentProject() projeto: ProjectScope["projeto"],
    @Param("id", ParseIntPipe) id: number,
  ): Promise<{ ok: boolean }> {
    await this.service.excluir(escopoDe(usuario, projeto), id)
    return { ok: true }
  }
}
