/**
 * VisoesTarefasGlobalController — visões por área e por categoria (tags)
 * (gestao-de-tarefas-global — macro #8, subtarefa 1; REQ-F-004).
 *
 * Rotas (prefixo /api) — SOMENTE LEITURA, sempre sob o slug do projeto:
 * - GET /:slug/visoes/resumo
 * - GET /:slug/visoes/tarefas?areaId=|tagId=&status=&prazo=&responsavelId=
 *
 * Contratos de resposta (telas do mapa de telas consomem este formato):
 * - resumo →
 *   {
 *     areas: Array<{ id, nome, total, pendentes, vencidas }>,
 *     tags:  Array<{ id, nome, total, pendentes, vencidas }>
 *   }
 *   Grupos = áreas/tags DA ORGANIZAÇÃO DA SESSÃO (ordenadas por nome);
 *   sem tarefas → zeros; área/tag de outra organização → lista vazia
 *   (sem vazamento de existência).
 * - tarefas → { items: Array<{ id, titulo, descricao, prioridade, prazo,
 *   status, areaId, areaNome, responsavelId, responsavelNome }>, total }
 *   (padrão de tolerância `{items,total}` das telas existentes), ordenada
 *   por prazo ASC (NULL por último), desempate prioridade DESC + id ASC.
 *
 * Query (`tarefas`): `areaId` OU `tagId` (nunca os dois — 400), `status`
 * multi (CSV ou repetida), `prazo` ∈ vencida|hoje|semana|sem_prazo,
 * `responsavelId` — todos combináveis; inválidos → 400 com `details`.
 *
 * Guards: JwtAuthGuard + ProjectScopeGuard + EscopoVisoesPorSlugGuard
 * (contexto de organização/colaborador da sessão). Isolamento row-level:
 * o WHERE de organização é aplicado em TODAS as consultas do service.
 */
import { BadRequestException, Controller, Get, Param, Query, UseGuards } from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { CurrentProject } from "../../common/decorators/current.decorator"
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard"
import { ProjectScopeGuard } from "../../common/guards/project-scope.guard"
import type { RequisicaoComEscopoOrganizacao } from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import { visoesTarefasQuerySchema } from "./dto/visoes-tarefas.schemas"
import { EscopoVisoesPorSlugGuard } from "./escopo-visoes-por-slug.guard"
import { VisoesTarefasGlobalService } from "./visoes-tarefas-global.service"

@Controller()
@UseGuards(JwtAuthGuard, ProjectScopeGuard, EscopoVisoesPorSlugGuard)
export class VisoesTarefasGlobalController {
  constructor(private readonly service: VisoesTarefasGlobalService) {}

  @Get(":slug/visoes/resumo")
  async resumo(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    return this.service.resumo(projeto, ctx)
  }

  @Get(":slug/visoes/tarefas")
  async tarefas(
    @CurrentProject() projeto: ProjetoResumo,
    @Param("slug") slug: string,
    @Query() query: unknown,
    req: RequisicaoComEscopoOrganizacao,
  ) {
    if (slug !== projeto.slug) throw new BadRequestException("Projeto inválido")
    const ctx = this.service.contextoDaRequest(req)
    const parsed = visoesTarefasQuerySchema.safeParse(query ?? {})
    if (!parsed.success) throw this.erroQuery(parsed.error.issues)
    return this.service.tarefasDaVisao(projeto, ctx, parsed.data)
  }

  private erroQuery(issues: Array<{ path: PropertyKey[]; message: string }>) {
    return new BadRequestException({
      message: "Parâmetros de consulta inválidos",
      details: issues.map((issue) => ({
        caminho: issue.path.join("."),
        problema: issue.message,
      })),
    })
  }
}
