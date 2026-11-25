/**
 * VisoesTarefasGlobalService — visões por área e por categoria (tags)
 * (gestao-de-tarefas-global — macro #8, subtarefa 1; REQ-F-004).
 *
 * Endpoints (somente leitura):
 * - `resumo`: grupos por área e por tag com `total`/`pendentes`/`vencidas`
 *   por grupo;
 * - `tarefasDaVisao`: lista de tarefas filtrada por `areaId` OU `tagId`
 *   (M:N via `tarefa_tags`), com filtros combináveis `status` (multi),
 *   bucket de `prazo` e `responsavelId`; resposta `{ items, total }`.
 *
 * Semântica das contagens (idêntica em área e tag):
 * - `total` = todas as tarefas do grupo (qualquer status);
 * - `pendentes` = status NOT IN ('concluida','cancelada') — abertas,
 *   delegadas, precisando de informações e aguardando terceiro;
 * - `vencidas` = pendentes AND prazo < NOW(), calculado no SERVIDOR
 *   (relógio do processo — mesmo padrão do DashboardScreen: vencida =
 *   prazo < agora); tarefa SEM prazo nunca conta como vencida;
 * - grupos vêm das tabelas `areas`/`tags` DA ORGANIZAÇÃO DA SESSÃO —
 *   área/tag de outra organização não aparece (lista vazia) e tarefa de
 *   outra organização nunca entra em nenhuma contagem.
 *
 * Buckets de prazo (filtro da lista, relativo ao relógio do servidor):
 * - 'vencida'   → prazo < agora (independe do status — combine com
 *   `status` para excluir concluídas/canceladas);
 * - 'hoje'      → agora ≤ prazo ≤ agora + 24h (espelha "vence em ≤24h"
 *   do DashboardScreen);
 * - 'semana'    → agora ≤ prazo ≤ agora + 7 dias;
 * - 'sem_prazo' → prazo IS NULL.
 *
 * Implementação: as consultas SQL carregam linhas escopadas por
 * organização no WHERE (row-level isolation — vazamento impossível por
 * construção); agrupamento, buckets e ordenação são resolvidos em JS
 * sobre o resultado (volumes por organização são pequenos e a semântica
 * fica 100% testável em spec unitária). Ordenação padrão da lista: prazo
 * ASC com NULL por último, desempate por prioridade DESC
 * (urgente → alta → média → baixa) e id ASC.
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common"
import { and, eq, inArray, type SQL } from "drizzle-orm"
import type { Perfil, ProjetoResumo } from "@biblioteca-global/shared"
import {
  areas,
  colaboradores,
  tags,
  tarefaTags,
  tarefas,
} from "../../../../../projects/gestao-de-tarefas-global/schema"
import { exigirContextoColaborador } from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/resolvers"
import {
  SemColaboradorAtivoError,
  type RequisicaoComEscopoOrganizacao,
} from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import { ehErroDatabaseAusente } from "../../common/erros"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
} from "../crud/project-db.factory"
import type {
  BucketPrazo,
  StatusTarefaVisao,
  VisoesTarefasQuery,
} from "./dto/visoes-tarefas.schemas"

/** Contexto de colaborador da sessão (guard de escopo já validou). */
export interface ContextoSessao {
  organizacaoId: number
  colaboradorId: number
  perfil: Perfil
}

/**
 * Token opcional do relógio do servidor (padrão do RecorrenciaAgendador):
 * specs injetam uma função que retorna "agora" fixo; em produção não é
 * registrado e o default `new Date()` vale.
 */
export const VISAOES_RELOGIO = Symbol("VISAOES_RELOGIO")

/** Um grupo (área ou tag) do resumo, com as três contagens. */
export interface GrupoVisao {
  id: number
  nome: string
  total: number
  pendentes: number
  vencidas: number
}

export interface ResumoVisoes {
  areas: GrupoVisao[]
  tags: GrupoVisao[]
}

export interface ItemTarefaVisao {
  id: number
  titulo: string
  descricao: string | null
  prioridade: string
  /** String do banco (`YYYY-MM-DD HH:mm:ss`, relógio do servidor) ou NULL. */
  prazo: string | null
  status: StatusTarefaVisao
  areaId: number | null
  areaNome: string | null
  responsavelId: number | null
  responsavelNome: string | null
}

/** Status que ENCERRAM a vida da tarefa — não contam como pendentes/vencidas. */
const STATUS_TERMINAIS = new Set<string>(["concluida", "cancelada"])

/** Peso de ordenação por prioridade (menor = mais urgente primeiro). */
const ORDEM_PRIORIDADE: Record<string, number> = {
  urgente: 0,
  alta: 1,
  media: 2,
  baixa: 3,
}

const MS_DIA = 24 * 60 * 60 * 1000

/** Prazo (string do banco, modo "string" no schema) → Date ou null. */
function dataPrazo(prazo: string | null | undefined): Date | null {
  if (!prazo) return null
  const normalizado = prazo.includes("T") ? prazo : prazo.replace(" ", "T")
  const d = new Date(normalizado)
  return Number.isNaN(d.getTime()) ? null : d
}

@Injectable()
export class VisoesTarefasGlobalService {
  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    /**
     * Relógio do servidor injetável (opcional — default `new Date()` por
     * chamada); specs fixam "agora" para testar buckets de prazo e
     * vencidas com o mesmo padrão do RecorrenciaAgendadorService.
     */
    @Optional() @Inject(VISAOES_RELOGIO) private readonly relogio: (() => Date) | undefined,
  ) {}

  private agora(): Date {
    return (this.relogio ?? (() => new Date()))()
  }

  // ==========================================================================
  // Contexto / escopo (mesmo padrão do módulo de fluxo)
  // ==========================================================================

  /**
   * Contexto de negócio a partir da request (guard de escopo executado):
   * master da plataforma e usuário sem colaborador ativo → 403.
   */
  contextoDaRequest(req: RequisicaoComEscopoOrganizacao): ContextoSessao {
    if (!req.escopoOrganizacao) {
      throw new ForbiddenException(
        "Contexto de organização não resolvido — EscopoOrganizacaoGuard não executou.",
      )
    }
    try {
      const contexto = exigirContextoColaborador(req.escopoOrganizacao)
      return {
        organizacaoId: contexto.organizacaoId,
        colaboradorId: contexto.colaboradorId,
        perfil: contexto.perfil,
      }
    } catch (erro) {
      if (erro instanceof SemColaboradorAtivoError) {
        throw new ForbiddenException(erro.message)
      }
      throw erro
    }
  }

  private async dbDoProjeto(projeto: ProjetoResumo) {
    try {
      return await this.factory.obter({ id: projeto.id })
    } catch (erro: unknown) {
      if (ehErroDatabaseAusente(erro)) {
        throw new NotFoundException("Database do projeto indisponível")
      }
      throw erro
    }
  }

  // ==========================================================================
  // GET /:slug/visoes/resumo
  // ==========================================================================

  /**
   * Grupos por área e por tag da organização da sessão, cada um com
   * `total`/`pendentes`/`vencidas`. Áreas/tags sem tarefas aparecem com
   * zeros; grupos de outra organização NUNCA são retornados.
   */
  async resumo(projeto: ProjetoResumo, ctx: ContextoSessao): Promise<ResumoVisoes> {
    const db = await this.dbDoProjeto(projeto)
    // Relógio do servidor amostrado uma vez — mesma referência para todas
    // as contagens (vencidas usa `prazo < agora`, REQ-F-004.contagens).
    const agora = this.agora()

    const [linhasAreas, linhasTarefas, linhasTags, linksTags] = await Promise.all([
      db
        .select({ id: areas.id, nome: areas.nome })
        .from(areas)
        .where(eq(areas.organizacaoId, ctx.organizacaoId)),
      db
        .select({
          id: tarefas.id,
          areaId: tarefas.areaId,
          status: tarefas.status,
          prazo: tarefas.prazo,
        })
        .from(tarefas)
        .where(eq(tarefas.organizacaoId, ctx.organizacaoId)),
      db
        .select({ id: tags.id, nome: tags.nome })
        .from(tags)
        .where(eq(tags.organizacaoId, ctx.organizacaoId)),
      // Contagem por tag via JOIN M:N em `tarefa_tags` (constraint única
      // tarefa_tags_tarefa_id_tag_id_unique garante 1 linha por par
      // tarefa×tag — sem duplicatas); escopo por organização no WHERE.
      db
        .select({
          tarefaId: tarefas.id,
          tagId: tarefaTags.tagId,
          status: tarefas.status,
          prazo: tarefas.prazo,
        })
        .from(tarefas)
        .innerJoin(tarefaTags, eq(tarefaTags.tarefaId, tarefas.id))
        .where(eq(tarefas.organizacaoId, ctx.organizacaoId)),
    ])

    const contar = (
      linhas: Array<{ status: string; prazo: string | null }>,
    ): Omit<GrupoVisao, "id" | "nome"> => {
      let pendentes = 0
      let vencidas = 0
      for (const linha of linhas) {
        const pendente = !STATUS_TERMINAIS.has(linha.status)
        if (!pendente) continue
        pendentes += 1
        const prazo = dataPrazo(linha.prazo)
        if (prazo && prazo.getTime() < agora.getTime()) vencidas += 1
      }
      return { total: linhas.length, pendentes, vencidas }
    }

    const gruposAreas: GrupoVisao[] = linhasAreas
      .map((area) => {
        const doGrupo = linhasTarefas.filter((t) => Number(t.areaId) === Number(area.id))
        return { id: Number(area.id), nome: area.nome, ...contar(doGrupo) }
      })
      .sort((a, b) => a.nome.localeCompare(b.nome))

    const gruposTags: GrupoVisao[] = linhasTags
      .map((tag) => {
        const doGrupo = linksTags.filter((l) => Number(l.tagId) === Number(tag.id))
        return { id: Number(tag.id), nome: tag.nome, ...contar(doGrupo) }
      })
      .sort((a, b) => a.nome.localeCompare(b.nome))

    return { areas: gruposAreas, tags: gruposTags }
  }

  // ==========================================================================
  // GET /:slug/visoes/tarefas
  // ==========================================================================

  /**
   * Lista filtrada por `areaId` OU `tagId` (excludentes — validado no DTO),
   * com filtros combináveis `status` (multi), `prazo` (bucket) e
   * `responsavelId`, sempre dentro da organização da sessão. Resposta
   * `{ items, total }` (padrão de tolerância das telas existentes).
   */
  async tarefasDaVisao(
    projeto: ProjetoResumo,
    ctx: ContextoSessao,
    query: VisoesTarefasQuery,
  ): Promise<{ items: ItemTarefaVisao[]; total: number }> {
    const db = await this.dbDoProjeto(projeto)
    const agora = this.agora()

    const condicoes: SQL[] = [eq(tarefas.organizacaoId, ctx.organizacaoId)]
    if (query.areaId != null) condicoes.push(eq(tarefas.areaId, query.areaId))
    if (query.tagId != null) condicoes.push(eq(tarefaTags.tagId, query.tagId))
    if (query.responsavelId != null) {
      condicoes.push(eq(tarefas.responsavelId, query.responsavelId))
    }
    if (query.status && query.status.length > 0) {
      condicoes.push(inArray(tarefas.status, query.status))
    }
    const where = and(...condicoes)

    const campos = {
      id: tarefas.id,
      titulo: tarefas.titulo,
      descricao: tarefas.descricao,
      prioridade: tarefas.prioridade,
      prazo: tarefas.prazo,
      status: tarefas.status,
      areaId: tarefas.areaId,
      areaNome: areas.nome,
      responsavelId: tarefas.responsavelId,
      responsavelNome: colaboradores.nome,
    }

    const linhas = query.tagId != null
      ? await db
          .select(campos)
          .from(tarefas)
          .innerJoin(tarefaTags, eq(tarefaTags.tarefaId, tarefas.id))
          .leftJoin(areas, eq(tarefas.areaId, areas.id))
          .leftJoin(colaboradores, eq(tarefas.responsavelId, colaboradores.id))
          .where(where)
      : await db
          .select(campos)
          .from(tarefas)
          .leftJoin(areas, eq(tarefas.areaId, areas.id))
          .leftJoin(colaboradores, eq(tarefas.responsavelId, colaboradores.id))
          .where(where)

    const filtradas = query.prazo
      ? linhas.filter((l) => pertenceBucket(query.prazo as BucketPrazo, l.prazo, agora))
      : linhas

    const ordenadas = [...filtradas].sort((a, b) => {
      const pa = dataPrazo(a.prazo)
      const pb = dataPrazo(b.prazo)
      // prazo ASC com NULL por último.
      if ((pa == null) !== (pb == null)) return pa == null ? 1 : -1
      if (pa && pb && pa.getTime() !== pb.getTime()) return pa.getTime() - pb.getTime()
      // Desempate: prioridade DESC (urgente primeiro) e id ASC.
      const wa = ORDEM_PRIORIDADE[a.prioridade] ?? 99
      const wb = ORDEM_PRIORIDADE[b.prioridade] ?? 99
      if (wa !== wb) return wa - wb
      return Number(a.id) - Number(b.id)
    })

    const items: ItemTarefaVisao[] = ordenadas.map((l) => ({
      id: Number(l.id),
      titulo: l.titulo,
      descricao: l.descricao,
      prioridade: l.prioridade,
      prazo: l.prazo,
      status: l.status as StatusTarefaVisao,
      areaId: l.areaId == null ? null : Number(l.areaId),
      areaNome: l.areaNome,
      responsavelId: l.responsavelId == null ? null : Number(l.responsavelId),
      responsavelNome: l.responsavelNome,
    }))

    return { items, total: items.length }
  }
}

/** Bucket de prazo (semântica documentada no cabeçalho do arquivo). */
export function pertenceBucket(bucket: BucketPrazo, prazo: string | null, agora: Date): boolean {
  if (bucket === "sem_prazo") return prazo == null
  const d = dataPrazo(prazo)
  if (!d) return false
  const t = d.getTime()
  const agoraMs = agora.getTime()
  switch (bucket) {
    case "vencida":
      return t < agoraMs
    case "hoje":
      return t >= agoraMs && t <= agoraMs + MS_DIA
    case "semana":
      return t >= agoraMs && t <= agoraMs + 7 * MS_DIA
    default:
      return false
  }
}
