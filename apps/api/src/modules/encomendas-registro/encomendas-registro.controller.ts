/**
 * EncomendasRegistroController — endpoints customizados para registro rápido.
 *
 * Rotas (prefixo /api):
 * - GET  /:slug/encomendas-registro/unidades
 * - GET  /:slug/encomendas-registro/transportadoras
 * - POST /:slug/encomendas-registro
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
import { EncomendasRegistroService } from "./encomendas-registro.service"
import {
  buscaUnidadesQuerySchema,
  type BuscaUnidadesQueryInput,
} from "./dto/busca-unidades-query.dto"
import {
  buscaTransportadorasQuerySchema,
  type BuscaTransportadorasQuery,
} from "./dto/busca-transportadoras-query.dto"
import {
  registroEncomendaBodySchema,
  type RegistroEncomendaBody,
} from "./dto/registro-encomenda-body.dto"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class EncomendasRegistroController {
  constructor(
    @Inject(EncomendasRegistroService)
    private readonly service: EncomendasRegistroService,
  ) {}

  /**
   * GET /:slug/encomendas-registro/unidades
   *
   * Busca unidades do condomínio por múltiplos critérios (label, rua, bloco,
   * numero, quadra, lote, nome de morador). Retorna identificação amigável
   * (sem IDs técnicos) e moradores ativos para confirmação visual.
   */
  @Get(":slug/encomendas-registro/unidades")
  async buscarUnidades(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Query() query: Record<string, string>,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const parsed = buscaUnidadesQuerySchema.safeParse(query)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Parâmetros de busca inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    return this.service.buscarUnidades(projeto, parsed.data)
  }

  /**
   * GET /:slug/encomendas-registro/transportadoras
   *
   * Busca transportadoras com indicador de recorrência (frequência de uso
   * nas encomendas recentes do condomínio). Facilita seleção rápida na
   * portaria — transportadoras mais usadas aparecem primeiro.
   */
  @Get(":slug/encomendas-registro/transportadoras")
  async buscarTransportadoras(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Query() query: Record<string, string>,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const parsed = buscaTransportadorasQuerySchema.safeParse(query)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Parâmetros de busca inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    return this.service.buscarTransportadoras(
      projeto,
      parsed.data as BuscaTransportadorasQuery,
    )
  }

  /**
   * POST /:slug/encomendas-registro
   *
   * Registra encomenda pendente vinculada exclusivamente à unidade e
   * condomínio do contexto autorizado. Aciona notificação para moradores
   * ativos da unidade. Falha de notificação é registrada e retornada,
   * mas não impede o registro.
   */
  @Post(":slug/encomendas-registro")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador")
  async registrar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Body() body: unknown,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }
    const parsed = registroEncomendaBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Dados de registro inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    return this.service.registrar(projeto, parsed.data as RegistroEncomendaBody)
  }
}
