/**
 * NotificacoesMoradorController — endpoints para o morador visualizar e
 * gerenciar suas notificações (sininho).
 *
 * Rotas (prefixo /api):
 * - GET  /:slug/notificacoes/morador — lista notificações do morador
 * - PATCH /:slug/notificacoes/:id/marcar-lida — marca notificação como lida
 *
 * Todas exigem autenticação (JWT) e escopo de projeto (ProjectScopeGuard).
 * Os dados são restritos ao morador autenticado.
 *
 * IMPORTANTE: Marcar notificação como lida NÃO afeta o status da encomenda.
 * A confirmação de reconhecimento é uma ação separada (ver encomendas-morador).
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common"
import type { ProjetoResumo, UsuarioAutenticado } from "@biblioteca-global/shared"
import { CurrentProject, CurrentUser } from "../../common/decorators/current.decorator"
import { Roles } from "../../common/decorators/roles.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { RolesGuard } from "../../common/guards/roles.guard"
import { NotificacoesMoradorService } from "./notificacoes-morador.service"
import {
  notificacoesMoradorQuerySchema,
  type NotificacoesMoradorQuery,
} from "./dto/notificacoes-morador-query.dto"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard)
export class NotificacoesMoradorController {
  constructor(private readonly service: NotificacoesMoradorService) {}

  /**
   * GET /:slug/notificacoes/morador
   *
   * Lista notificações do morador autenticado.
   * Suporta filtro por não lidas e paginação.
   *
   * Query params:
   * - apenasNaoLidas: boolean (default false)
   * - limit: limite de resultados (default 50, max 200)
   * - offset: offset para paginação (default 0)
   *
   * Retorna também contagem total e de não lidas para o badge do sininho.
   */
  @Get(":slug/notificacoes/morador")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador", "visualizador")
  async listarNotificacoes(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
    @Query() query: Record<string, string>,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }

    const parsed = notificacoesMoradorQuerySchema.safeParse(query)
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Parâmetros de consulta inválidos",
        details: parsed.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }

    return this.service.listarNotificacoes(
      projeto,
      usuario,
      parsed.data as NotificacoesMoradorQuery,
    )
  }

  /**
   * PATCH /:slug/notificacoes/:id/marcar-lida
   *
   * Marca notificação como lida.
   *
   * IMPORTANTE: Esta ação NÃO afeta o status da encomenda.
   * A confirmação de reconhecimento é uma ação separada.
   */
  @Patch(":slug/notificacoes/:id/marcar-lida")
  @UseGuards(RolesGuard)
  @Roles("admin", "gerente", "operador", "visualizador")
  async marcarComoLida(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
    @Param("id") idParam: string,
  ) {
    if (slug !== projeto.slug) {
      throw new NotFoundException("Projeto não encontrado")
    }

    const notificacaoId = Number(idParam)
    if (!Number.isInteger(notificacaoId) || notificacaoId <= 0) {
      throw new BadRequestException("ID da notificação deve ser um número inteiro positivo")
    }

    return this.service.marcarComoLida(projeto, usuario, notificacaoId)
  }

  /** Aliases legados preservados para clientes já publicados. */
  @Get(":slug/notificacoes/morador")
  async listarNotificacoesLegado(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
    @Query() query: Record<string, string>,
  ) {
    if (slug !== projeto.slug) throw new NotFoundException("Projeto não encontrado")
    const parsed = notificacoesMoradorQuerySchema.safeParse(query)
    if (!parsed.success) throw new BadRequestException("Parâmetros de consulta inválidos")
    return this.service.listarNotificacoes(projeto, usuario, parsed.data as NotificacoesMoradorQuery)
  }

  @Patch(":slug/notificacoes/:id/marcar-lida")
  async marcarComoLidaLegado(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
    @Param("id") idParam: string,
  ) {
    return this.marcarComoLida(projeto, usuario, slug, idParam)
  }
}
