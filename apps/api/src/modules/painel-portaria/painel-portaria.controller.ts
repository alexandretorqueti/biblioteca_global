/**
 * PainelPortariaController — endpoints do painel da portaria.
 *
 * Rotas (prefixo /api):
 * - GET  /:slug/painel-portaria/encomendas          (lista com filtros + indicadores)
 * - GET  /:slug/painel-portaria/encomendas/:id       (detalhe com foto e destino)
 * - POST /:slug/painel-portaria/encomendas/:id/entregar       (registrar entrega)
 * - POST /:slug/painel-portaria/encomendas/:id/reenviar-aviso (reenviar aviso ao morador)
 *
 * Todas exigem autenticação (JWT) e escopo de projeto (ProjectScopeGuard).
 * Escrita (POST) exige perfil admin/gerente/operador.
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
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { PainelPortariaService } from "./painel-portaria.service"
import {
  painelPortariaQuerySchema,
  type PainelPortariaQuery,
} from "./dto/painel-portaria-query.dto"
import {
  entregaBodySchema,
  type EntregaBody,
} from "./dto/entrega-body.dto"
import {
  reenviarAvisoBodySchema,
  type ReenviarAvisoBody,
} from "./dto/reenviar-aviso-body.dto"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class PainelPortariaController {
  constructor(
    @Inject(PainelPortariaService)
    private readonly service: PainelPortariaService,
  ) {}

  /**
   * GET /:slug/painel-portaria/encomendas
   *
   * Lista encomendas filtradas por estado operacional, transportadora,
   * localização da unidade, período e busca textual. Retorna também
   * indicadores (contadores) do painel.
   */
  @Get(":slug/painel-portaria/encomendas")
  async listarEncomendas(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Query() query: Record<string, string>,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const parsed = painelPortariaQuerySchema.safeParse(query)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Parâmetros de filtro inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    return this.service.listarEncomendas(projeto, parsed.data as PainelPortariaQuery)
  }

  /**
   * GET /:slug/painel-portaria/encomendas/:id
   *
   * Detalhe completo da encomenda: foto, destino (unidade + moradores),
   * transportadora, funcionário que registrou e dados de entrega/confirmação.
   */
  @Get(":slug/painel-portaria/encomendas/:id")
  async obterDetalhe(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id") id: string,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const encomendaId = Number(id)
    if (!Number.isInteger(encomendaId) || encomendaId <= 0) {
      throw new BadRequestException("ID de encomenda inválido")
    }
    return this.service.obterDetalhe(projeto, encomendaId)
  }

  /**
   * POST /:slug/painel-portaria/encomendas/:id/entregar
   *
   * Registra entrega de encomenda. Valida status=confirmada, cria registro
   * na tabela entregas com evidência completa, atualiza encomenda para
   * status=entregue.
   *
   * Somente encomendas confirmadas podem ser entregues. Pendentes,
   * canceladas e já entregues são bloqueadas com mensagem clara.
   */
  @Post(":slug/painel-portaria/encomendas/:id/entregar")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  async registrarEntrega(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const encomendaId = Number(id)
    if (!Number.isInteger(encomendaId) || encomendaId <= 0) {
      throw new BadRequestException("ID de encomenda inválido")
    }
    const parsed = entregaBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Dados de entrega inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    return this.service.registrarEntrega(
      projeto,
      encomendaId,
      parsed.data as EntregaBody,
    )
  }

  /**
   * POST /:slug/painel-portaria/encomendas/:id/reenviar-aviso
   *
   * Reenvia notificação ao morador sobre encomenda pendente ou confirmada.
   * Para entregues/canceladas, retorna erro explicando o motivo.
   */
  @Post(":slug/painel-portaria/encomendas/:id/reenviar-aviso")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  async reenviarAviso(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const encomendaId = Number(id)
    if (!Number.isInteger(encomendaId) || encomendaId <= 0) {
      throw new BadRequestException("ID de encomenda inválido")
    }
    const parsed = reenviarAvisoBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Dados de reenvio de aviso inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    return this.service.reenviarAviso(
      projeto,
      encomendaId,
      parsed.data as ReenviarAvisoBody,
    )
  }
}
