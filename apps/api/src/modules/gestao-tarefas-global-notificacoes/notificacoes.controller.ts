/**
 * NotificacoesController — sino do usuário logado (gestao-de-tarefas-global
 * — macro #5, subtarefa 2).
 *
 * Rotas (registadas ANTES do CrudModule no app.module — mais específicas):
 * - GET  /api/:slug/notificacoes                     → itens (+naoLidas)
 * - GET  /api/:slug/notificacoes/nao-lidas/contagem  → badge do sino
 * - POST /api/:slug/notificacoes/lidas-todas         → marcar todas
 * - POST /api/:slug/notificacoes/:id/lida            → marcar uma
 *
 * Segurança:
 * - `usuarioId` é SEMPRE o usuário da sessão (`UsuarioAutenticado.id` =
 *   claims.sub, revalidado pelo ProjectScopeGuard) — nunca query/body/param;
 * - rota de projeto sem as tabelas do projeto de gestão → 404 (o escopo de
 *   notificações é exclusivo do slug `gestao-de-tarefas-global`);
 * - sem `req.escopoOrganizacao` obrigatório: as queries são por usuarioId
 *   global (a coluna organizacao_id marca origem, não restrição de leitura).
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common"
import type { ProjetoResumo, UsuarioAutenticado } from "@biblioteca-global/shared"
import {
  CurrentProject,
  CurrentUser,
} from "../../common/decorators/current.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import { SLUG_GESTAO_TAREFAS_GLOBAL } from "../crud/escopo/gestao-tarefas-global.escopo"
import { EscopoFluxoPorSlugGuard } from "../gestao-tarefas-global-fluxo/escopo-fluxo-por-slug.guard"
import { listarNotificacoesQuerySchema } from "./dto/notificacoes.schemas"
import { NotificacoesService } from "./notificacoes.service"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard, EscopoFluxoPorSlugGuard)
export class NotificacoesController {
  constructor(private readonly service: NotificacoesService) {}

  @Get(":slug/notificacoes")
  async listar(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
    @Query() query: unknown,
  ) {
    this.validarEscopo(slug, projeto)
    const parsed = listarNotificacoesQuerySchema.safeParse(query ?? {})
    if (!parsed.success) throw this.erroQuery(parsed.error.issues)
    return this.service.listar(projeto, usuario.id, {
      apenasNaoLidas: parsed.data.apenasNaoLidas === "true",
      limite: parsed.data.limite,
    })
  }

  @Get(":slug/notificacoes/nao-lidas/contagem")
  async contagem(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
  ) {
    this.validarEscopo(slug, projeto)
    return this.service.contarNaoLidas(projeto, usuario.id)
  }

  @Post(":slug/notificacoes/lidas-todas")
  async lidasTodas(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
  ) {
    this.validarEscopo(slug, projeto)
    return this.service.marcarTodasLidas(projeto, usuario.id)
  }

  @Post(":slug/notificacoes/:id/lida")
  async marcarLida(
    @CurrentProject() projeto: ProjetoResumo,
    @CurrentUser() usuario: UsuarioAutenticado,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
  ) {
    this.validarEscopo(slug, projeto)
    return this.service.marcarLida(projeto, usuario.id, id)
  }

  /** Slug do path == slug do token (padrão fluxo) e projeto de gestão. */
  private validarEscopo(slug: string, projeto: ProjetoResumo): void {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    if (projeto.slug !== SLUG_GESTAO_TAREFAS_GLOBAL) {
      throw new NotFoundException("Recurso não encontrado neste projeto.")
    }
  }

  private erroQuery(issues: Array<{ path: PropertyKey[]; message: string }>) {
    return new BadRequestException({
      message: "Query string inválida",
      details: issues.map((issue) => ({
        caminho: issue.path.join("."),
        problema: issue.message,
      })),
    })
  }
}
