/**
 * EncomendasMoradorController — endpoints para o morador visualizar e
 * confirmar suas encomendas.
 *
 * Rotas (prefixo /api):
 * - GET  /:slug/encomendas/morador — lista encomendas do morador autenticado
 * - PATCH /:slug/encomendas/:id/confirmar-reconhecimento — confirma reconhecimento
 *
 * Todas exigem autenticação (JWT) e escopo de projeto (ProjectScopeGuard).
 * Os dados são restritos às unidades do morador autenticado.
 *
 * IMPORTANTE: A confirmação de reconhecimento NÃO marca entrega.
 * A entrega física continua sendo ato exclusivo da portaria.
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common"
import type { ProjetoResumo, UsuarioAutenticado } from "@biblioteca-global/shared"
import { CurrentProject, CurrentUser } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { EncomendasMoradorService } from "./encomendas-morador.service"
import {
  encomendasMoradorQuerySchema,
  type EncomendasMoradorQuery,
} from "./dto/encomendas-morador-query.dto"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class EncomendasMoradorController {
  constructor(private readonly service: EncomendasMoradorService) {}

  /**
   * GET /:slug/encomendas/morador
   *
   * Lista encomendas das unidades do morador autenticado.
   * Suporta filtros por status/grupo e paginação.
   *
   * Query params:
   * - status: pendente | pronta_retirada | entregue | cancelada
   * - grupo: aguardando | prontas | historico
   * - limit: limite de resultados (default 50, max 200)
   * - offset: offset para paginação (default 0)
   */
  @Get(":slug/encomendas/morador")
  async listarEncomendas(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
    @Query() query: Record<string, string>,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }

    const parsed = encomendasMoradorQuerySchema.safeParse(query)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Parâmetros de consulta inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }

    return this.service.listarEncomendas(
      projeto,
      usuario,
      parsed.data as EncomendasMoradorQuery,
    )
  }

  /**
   * PATCH /:slug/encomendas/:id/confirmar-reconhecimento
   *
   * Confirma que o morador reconhece a encomenda.
   * Muda status para "pronta_retirada" e cria notificação.
   *
   * IMPORTANTE: Esta ação NÃO marca entrega.
   * A entrega física continua sendo ato exclusivo da portaria.
   */
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador", "visualizador")
  async confirmarReconhecimento(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
    @Param("id") idParam: string,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }

    const encomendaId = Number(idParam)
    if (!Number.isInteger(encomendaId) || encomendaId <= 0) {
      throw new BadRequestException("ID da encomenda deve ser um número inteiro positivo")
    }

    return this.service.confirmarReconhecimento(projeto, usuario, encomendaId)
  }
}
