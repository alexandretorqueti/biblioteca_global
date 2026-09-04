/**
 * OcorrenciasController — endpoints para registro e consulta de ocorrências.
 *
 * Rotas (prefixo /api):
 * - POST /:slug/ocorrencias — registra ocorrência (exige perfil operacional)
 * - GET  /:slug/ocorrencias — lista ocorrências do condomínio com paginação
 * - GET  /:slug/ocorrencias/encomenda/:encomendaId — histórico de ocorrências de uma encomenda
 *
 * Todas exigem autenticação (JWT) e escopo de projeto (ProjectScopeGuard).
 * Escrita (POST) exige perfil admin/gerente/operador.
 *
 * Segurança:
 * - Isolamento multi-tenant via condominioId do contexto autorizado.
 * - Histórico de ocorrências respeita permissões: morador vê apenas
 *   ocorrências de suas encomendas (filtrado via unidade).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { CurrentFuncionarioId } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { OcorrenciasService } from "./ocorrencias.service"
import {
  registroOcorrenciaBodySchema,
  tiposOcorrencia,
  type RegistroOcorrenciaBody,
  type TipoOcorrencia,
} from "./dto/registro-ocorrencia-body.dto"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class OcorrenciasController {
  constructor(
    @Inject(OcorrenciasService)
    private readonly service: OcorrenciasService,
  ) {}

  /**
   * POST /:slug/ocorrencias
   *
   * Registra ocorrência vinculada exclusivamente à encomenda do condomínio
   * autorizado. Aciona notificação para moradores ativos da unidade afetada.
   * Falha de notificação é registrada e retornada, mas não impede o registro.
   */
  @Post(":slug/ocorrencias")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  async registrar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Body() body: unknown,
    @CurrentFuncionarioId() funcionarioId: number,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const parsed = registroOcorrenciaBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Dados de ocorrência inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    return this.service.registrar(projeto, parsed.data as RegistroOcorrenciaBody, funcionarioId)
  }

  /**
   * GET /:slug/ocorrencias
   *
   * Lista ocorrências do condomínio com paginação e filtros opcionais.
   */
  @Get(":slug/ocorrencias")
  async listar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("encomendaId") encomendaId?: string,
    @Query("tipo") tipo?: string,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }

    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined
    const parsedOffset = offset ? Number.parseInt(offset, 10) : undefined
    const parsedEncomendaId = encomendaId ? Number.parseInt(encomendaId, 10) : undefined

    // Valida tipo se informado
    let parsedTipo: TipoOcorrencia | undefined
    if (tipo) {
      if (!tiposOcorrencia.includes(tipo as TipoOcorrencia)) {
        throw new BadRequestException(`Tipo inválido. Valores aceitos: ${tiposOcorrencia.join(", ")}`)
      }
      parsedTipo = tipo as TipoOcorrencia
    }

    return this.service.listar(projeto, {
      limit: parsedLimit,
      offset: parsedOffset,
      encomendaId: parsedEncomendaId,
      tipo: parsedTipo,
    })
  }

  /**
   * GET /:slug/ocorrencias/encomenda/:encomendaId
   *
   * Histórico de ocorrências de uma encomenda específica.
   * Respeita isolamento multi-tenant.
   */
  @Get(":slug/ocorrencias/encomenda/:encomendaId")
  async listarPorEncomenda(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("encomendaId") encomendaId: string,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const parsedEncomendaId = Number.parseInt(encomendaId, 10)
    if (Number.isNaN(parsedEncomendaId)) {
      throw new BadRequestException("ID de encomenda inválido")
    }
    return this.service.listarPorEncomenda(projeto, parsedEncomendaId)
  }
}
