/**
 * ProjetosController — CRUD restrito ao admin global: sessão do projeto
 * biblioteca-global + perfil admin (PoC §6.2).
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
import { Roles } from "../../common/decorators/roles.decorator"
import { GlobalAdminGuard } from "../../common/guards/global-admin.guard"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { ProjetosService } from "./projetos.service"
// DTOs com import de VALOR (o ValidationPipe resolve a classe em runtime).
import { CreateProjetoDto } from "./dto/create-projeto.dto"
import { UpdateProjetoDto } from "./dto/update-projeto.dto"

@Controller("projetos")
@UseGuards(JwtAuthGuard, ProjectScopeGuard, GlobalAdminGuard, RolesGuard)
@Roles("admin")
export class ProjetosController {
  constructor(
    @Inject(ProjetosService) private readonly service: ProjetosService,
  ) {}

  @Get()
  listar(@Query() query: Record<string, string>) {
    const page = query.page !== undefined ? Number(query.page) : undefined
    const pageSize =
      query.pageSize !== undefined ? Number(query.pageSize) : undefined
    return this.service.listar({ page, pageSize })
  }

  @Get(":id")
  detalhar(@Param("id", ParseIntPipe) id: number) {
    return this.service.detalhar(id)
  }

  @Post()
  criar(@Body() dto: CreateProjetoDto) {
    return this.service.criar(dto)
  }

  @Put(":id")
  atualizar(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateProjetoDto,
  ) {
    return this.service.atualizar(id, dto)
  }

  /** Soft delete — database preservado (PoC §6.2). */
  @Delete(":id")
  async desativar(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<{ ok: boolean }> {
    await this.service.desativar(id)
    return { ok: true }
  }
}
