/**
 * FluxoTarefasGlobalController — endpoints custom de fluxo da tarefa
 * (gestao-de-tarefas-global — macro #3, subtarefa 2).
 *
 * Rotas (prefixo /api) — sempre sob o slug do projeto da sessão:
 * - POST /:slug/tarefas/:id/delegar   { responsavelId }
 * - POST /:slug/tarefas/:id/devolver  { sabor, mensagem }
 * - POST /:slug/tarefas/:id/concluir  (atalho do sabor concluída)
 * - POST /:slug/tarefas/:id/cancelar  { motivo? }
 * - GET  /:slug/tarefas/:id/historico (cronológico, append-only — somente leitura)
 * - GET  /:slug/tarefas/:id/mensagens (chat — autor nome + data)
 * - POST /:slug/tarefas/:id/mensagens { texto } (autor = colaborador da sessão)
 *
 * Guards: JwtAuthGuard + ProjectScopeGuard (req.scope) + EscopoFluxoPorSlugGuard
 * (EscopoOrganizacaoGuard condicionado ao slug — req.escopoOrganizacao =
 * colaborador ativo da organização). NENHUMA rota
 * PUT/PATCH/DELETE em historico_tarefas (append-only por construção).
 *
 * Segurança:
 * - Escopo row-level: tarefa fora da organização da sessão → 404 (o id da
 *   tarefa nunca vaza existência de registro de outra organização);
 * - Autorização por ação no service (responsável atual / admin / gerente /
 *   criador para cancelar) → 403 com mensagem clara;
 * - O body NUNCA define o autor da mensagem nem a organização.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import type { RequisicaoComEscopoOrganizacao } from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import {
  cancelarBodySchema,
  delegarBodySchema,
  devolverBodySchema,
  mensagemChatBodySchema,
} from "./dto/fluxo-tarefas.schemas"
import { EscopoFluxoPorSlugGuard } from "./escopo-fluxo-por-slug.guard"
import { FluxoTarefasGlobalService } from "./fluxo-tarefas-global.service"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard, EscopoFluxoPorSlugGuard)
export class FluxoTarefasGlobalController {
  constructor(private readonly service: FluxoTarefasGlobalService) {}

  @Post(":slug/tarefas/:id/delegar")
  async delegar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    const parsed = delegarBodySchema.safeParse(body)
    if (!parsed.success) throw this.erroCorpo(parsed.error.issues)
    return this.service.delegar(projeto, ctx, id, parsed.data)
  }

  @Post(":slug/tarefas/:id/devolver")
  async devolver(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    const parsed = devolverBodySchema.safeParse(body)
    if (!parsed.success) throw this.erroCorpo(parsed.error.issues)
    return this.service.devolver(projeto, ctx, id, parsed.data)
  }

  @Post(":slug/tarefas/:id/concluir")
  async concluir(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    return this.service.concluir(projeto, ctx, id)
  }

  @Post(":slug/tarefas/:id/cancelar")
  async cancelar(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    // Body ausente é válido (motivo opcional).
    const parsed = cancelarBodySchema.safeParse(body ?? {})
    if (!parsed.success) throw this.erroCorpo(parsed.error.issues)
    return this.service.cancelar(projeto, ctx, id, parsed.data)
  }

  @Get(":slug/tarefas/:id/historico")
  async historico(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    return this.service.historico(projeto, ctx, id)
  }

  @Get(":slug/tarefas/:id/mensagens")
  async listarMensagens(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    return this.service.listarMensagens(projeto, ctx, id)
  }

  @Post(":slug/tarefas/:id/mensagens")
  async criarMensagem(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: unknown,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    const parsed = mensagemChatBodySchema.safeParse(body)
    if (!parsed.success) throw this.erroCorpo(parsed.error.issues)
    return this.service.criarMensagem(projeto, ctx, id, parsed.data)
  }

  private erroCorpo(issues: Array<{ path: PropertyKey[]; message: string }>) {
    return new BadRequestException({
      message: "Corpo da requisição inválido",
      details: issues.map((issue) => ({
        caminho: issue.path.join("."),
        problema: issue.message,
      })),
    })
  }
}
