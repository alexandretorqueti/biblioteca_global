// @vitest-environment node
/**
 * Testes unitários do VisoesTarefasGlobalService (gestao-de-tarefas-global —
 * macro #8, subtarefa 1): API de visões por área e por categoria (tags) —
 * GET /:slug/visoes/resumo e GET /:slug/visoes/tarefas (REQ-F-004).
 *
 * Estratégia: db fake encadeável (padrão do spec do módulo de fluxo) —
 * nenhuma dependência de MySQL. As condições de `where` são RENDERIZADAS
 * pelo dialect Drizzle real (sqlToQuery) e avaliadas contra as linhas-
 * fixture: o fake é fiel ao SQL efetivamente executado.
 *
 * Cobre (critérios de aceite da subtarefa):
 * - resumo: exatamente as áreas/tags DA ORGANIZAÇÃO DA SESSÃO, cada grupo
 *   com total/pendentes/vencidas; concluída/cancelada não contam como
 *   pendentes NEM vencidas; vencidas = pendentes AND prazo < relógio do
 *   SERVIDOR (relógio injetável) e exclui tarefas sem prazo;
 * - contagem por tag via JOIN M:N em `tarefa_tags` (sem duplicatas);
 * - tarefas: tagId lista apenas tarefas vinculadas (JOIN M:N, sem
 *   duplicatas), respeita filtros status (multi)/prazo (bucket)/
 *   responsavelId combináveis;
 * - ordenação padrão: prazo ASC com NULL por último + prioridade DESC;
 * - isolamento: área/tag de outra organização → vazio (nunca vazam
 *   tarefas de outra org); resumo nunca inclui grupos de outra org;
 * - 403: sem escopo de organização / sessão master da plataforma;
 * - 404: database do projeto ausente;
 * - DTO: validação da query (areaId OU tagId, status multi/CSV, buckets,
 *   ids numéricos) via visoesTarefasQuerySchema.
 */
import { describe, expect, it, vi } from "vitest"
import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { Perfil, ProjetoResumo } from "@biblioteca-global/shared"
import * as schemaGestao from "../../../../../../projects/gestao-de-tarefas-global/schema"
import type { ProjectDbFactory } from "../../crud/project-db.factory"
import {
  bucketPrazoValues,
  statusTarefaValues,
  visoesTarefasQuerySchema,
} from "../dto/visoes-tarefas.schemas"
import {
  pertenceBucket,
  VisoesTarefasGlobalService,
  type ContextoSessao,
} from "../visoes-tarefas-global.service"

// ============================================================================
// Fake de banco (encadeável, fiel ao SQL renderizado)
// ============================================================================

type Tabela = "tarefas" | "colaboradores" | "areas" | "tags" | "tarefa_tags"

interface DbFakeApi {
  db: unknown
}

const dialect = new MySqlDialect()

/** Tabela → mapeia nome de coluna snake_case (SQL) → chave camelCase da fixture. */
function chaveColunaPorTabela(): Map<Tabela, Map<string, string>> {
  const mapa = new Map<Tabela, Map<string, string>>()
  for (const [, tabela] of Object.entries(
    schemaGestao,
  ) as Array<[string, Record<string, unknown>]>) {
    // Drizzle 0.36+ guarda nome/marcação de tabela em symbols
    // (Symbol.for("drizzle:Name")), não em `__name`.
    const nomeTabela = (tabela as Record<symbol, unknown> | null)?.[
      Symbol.for("drizzle:Name")
    ] as string | undefined
    if (
      !nomeTabela ||
      !(tabela as Record<PropertyKey, unknown>)[Symbol.for("drizzle:IsDrizzleTable")]
    )
      continue
    const colunas = new Map<string, string>()
    for (const [prop, coluna] of Object.entries(tabela)) {
      if (prop === "__name") continue
      const nomeColuna = (coluna as { name?: string })?.name
      if (nomeColuna) colunas.set(nomeColuna, prop)
    }
    mapa.set(nomeTabela as Tabela, colunas)
  }
  return mapa
}

const CHAVES_POR_TABELA = chaveColunaPorTabela()

/** Coluna (SQL) → tabela que a possui (as colunas usadas nos WHEREs são
 *  únicas entre as tabelas deste projeto — organizacao_id/area_id/tag_id/
 *  responsavel_id/status). */
const TABELA_POR_COLUNA = new Map<string, Tabela>()
for (const [tabela, colunas] of CHAVES_POR_TABELA) {
  for (const sql of colunas.keys()) {
    if (!TABELA_POR_COLUNA.has(sql)) TABELA_POR_COLUNA.set(sql, tabela)
  }
}

function nomeDaTabela(tabela: unknown): Tabela {
  const nome = (tabela as Record<symbol, unknown> | null)?.[
    Symbol.for("drizzle:Name")
  ] as string | undefined
  return (nome ?? "?") as Tabela
}

interface CondicaoRenderizada {
  sql: string
  params: unknown[]
}

function renderizar(
  cond: { toSQL?: () => { sql: string; params: unknown[] } },
): CondicaoRenderizada {
  if (cond == null) return { sql: "", params: [] }
  let sql: string
  let params: unknown[]
  if (typeof cond.toSQL === "function") {
    const r = cond.toSQL()
    sql = r.sql
    params = r.params as unknown[]
  } else {
    // Wrapper `and(...)` do Drizzle não expõe toSQL — renderiza pelo
    // dialect real (mesmo padrão do spec de fluxo).
    const r = dialect.sqlToQuery(cond as never)
    sql = r.sql
    params = r.params as unknown[]
  }
  // O dialect mantém referências de coluna como parâmetros (`? = ?`);
  // inline-as como `` `col` `` — os params finais passam a ser apenas os
  // VALORES, na ordem dos placeholders `?`.
  const paramsFinais: unknown[] = []
  const iter = params[Symbol.iterator]()
  sql = sql.replace(/\?/g, () => {
    const { value, done } = iter.next()
    const maybeCol = value as { name?: unknown; tableName?: unknown } | null
    if (
      !done &&
      maybeCol &&
      typeof maybeCol === "object" &&
      typeof maybeCol.name === "string"
    ) {
      return `\`${maybeCol.name}\``
    }
    paramsFinais.push(value)
    return "?"
  })
  return { sql, params: paramsFinais }
}

/**
 * Extrai condições simples do SQL renderizado (QUALIFICADO):
 * `` `tabela`.`col` = ? `` e `` `tabela`.`col` IN (?, ...) ``.
 */
function extrairCondicoes(
  sql: string,
  params: unknown[],
): Array<{ tabela: Tabela; campo: string; operador: "=" | "in"; valores: unknown[] }> {
  const condicoes: Array<{ tabela: Tabela; campo: string; operador: "=" | "in"; valores: unknown[] }> = []
  // `` `tab`.`col` IN (?, ...) `` primeiro — as regiões ocupadas (por
  // placeholder `?`) são puladas no `=` para não double-contar.
  const reIn = /`(\w+)`\.`(\w+)` IN \(([^)]*)\)/gi
  const offsetsIn: Array<{ inicio: number; n: number }> = []
  let mIn: RegExpExecArray | null
  while ((mIn = reIn.exec(sql)) !== null) {
    const marcadores = (mIn[3]!.match(/\?/g) ?? []).length
    const inicio = sql.slice(0, mIn.index).split("?").length - 1
    offsetsIn.push({ inicio, n: marcadores })
    condicoes.push({
      tabela: mIn[1]! as Tabela,
      campo: mIn[2]!,
      operador: "in",
      valores: params.slice(inicio, inicio + marcadores),
    })
  }
  const foraDeIn = (inicio: number) =>
    !offsetsIn.some((o) => inicio >= o.inicio && inicio < o.inicio + o.n)
  // `` `tab`.`col` = ? `` — não casa com condição de join (` = `tab2`.`col2`).
  const reEq = /`(\w+)`\.`(\w+)` = \?/g
  let mEq: RegExpExecArray | null
  while ((mEq = reEq.exec(sql)) !== null) {
    const inicio = sql.slice(0, mEq.index).split("?").length - 1
    if (!foraDeIn(inicio)) continue
    condicoes.push({
      tabela: (mEq[1] ?? "") as Tabela,
      campo: mEq[2]!,
      operador: "=",
      valores: [params[inicio]],
    })
  }
  return condicoes
}

/** Igualdade do fake: numérica quando ambos são números finitos; senão string. */
function valorIgual(a: unknown, b: unknown): boolean {
  const na = Number(a)
  const nb = Number(b)
  if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
    return na === nb
  }
  return String(a) === String(b)
}

interface JoinInfo {
  tipo: "inner" | "left"
  tabela: Tabela
  /** Chave camelCase da fixture na linha ESQUERDA do join. */
  chaveLocal: string
  /** Chave camelCase da fixture na tabela DIREITA. */
  chaveRemota: string
}

/**
 * JOIN com condição `eq(colEsq, colDir)` — o dialect renderiza QUALIFICADO
 * (`` `tab_esq`.`col_esq` = `tab_dir`.`col_dir` ``); mapeia as COLUNAS para
 * as chaves camelCase das fixtures.
 */
function registrarJoin(
  tipo: "inner" | "left",
  tabelaEsq: Tabela,
  tabelaDir: Tabela,
  cond: unknown,
): JoinInfo {
  const { sql } = renderizar(cond as never)
  const m = sql.match(/`(\w+)`\.`(\w+)`\s*=\s*`(\w+)`\.`(\w+)`/)
  if (!m) throw new Error(`condição de join não suportada no fake: ${sql}`)
  // Lado esquerdo = tabela BASE (local); lado direito = tabela JOINADA.
  const [colLocalSql, colRemotaSql] =
    m[1] === tabelaEsq ? [m[2]!, m[4]!] : [m[4]!, m[2]!]
  const chavesEsq = CHAVES_POR_TABELA.get(tabelaEsq) ?? new Map()
  const chavesDir = CHAVES_POR_TABELA.get(tabelaDir) ?? new Map()
  return {
    tipo,
    tabela: tabelaDir,
    chaveLocal: chavesEsq.get(colLocalSql) ?? colLocalSql,
    chaveRemota: chavesDir.get(colRemotaSql) ?? colRemotaSql,
  }
}

/** Linha materializada do fake: base + linhas do lado direito dos joins. */
interface LinhaMaterializada {
  base: Record<string, unknown>
  joins: Partial<Record<Tabela, Record<string, unknown> | null>>
}

function dbFake(
  fixture: Record<string, Array<Record<string, unknown>>>,
): DbFakeApi {
  const whereChain = (
    tabela: Tabela,
    cond: unknown,
    extra: { joins: JoinInfo[]; projecao: Map<string, { chave: string; tabela: Tabela }> | null },
  ) => {
    const { sql: condSql, params: condParams } = cond == null
      ? { sql: "", params: [] as unknown[] }
      : renderizar(cond as never)
    const condicoes = extrairCondicoes(condSql, condParams)

    // 1) Filtro da tabela BASE — condições qualificadas `base`.`col` são
    //    avaliadas aqui; as demais (exclusivas de tabela JOINADA, ex.
    //    `tarefa_tags`.`tag_id`) aguardam o join. O dialect qualifica
    //    sempre, então não há ambiguidade.
    const temColuna = (t: Tabela, sql: string) =>
      (CHAVES_POR_TABELA.get(t) ?? new Map<string, string>()).has(sql)
    const linhasBase = (fixture[tabela] ?? []).filter((linha) => {
      return condicoes.every((c) => {
        if (c.tabela !== tabela || !temColuna(tabela, c.campo)) return true // join → passo 2
        const chave = CHAVES_POR_TABELA.get(tabela)!.get(c.campo)!
        return c.operador === "in"
          ? c.valores.some((v) => valorIgual(v, linha[chave]))
          : valorIgual(c.valores[0]!, linha[chave])
      })
    })

    // 2) MATERIALIZAÇÃO dos joins (ordem declarada) — inner restringe
    //    (1 linha por match), left enriquece (null sem match).
    const materializadas: LinhaMaterializada[] = []
    for (const linha of linhasBase) {
      materializadas.push({ base: linha, joins: {} })
    }
    for (const join of extra.joins) {
      const proximas: LinhaMaterializada[] = []
      for (const m of materializadas) {
        // Condições do WHERE sobre colunas desta tabela: o match do join
        // precisa satisfazê-las (SQL: WHERE se aplica após o JOIN).
        const matches = (fixture[join.tabela] ?? []).filter((j) => {
          const chavesDir = CHAVES_POR_TABELA.get(join.tabela)!
          const cDoJoin = condicoes.filter((c) => c.tabela === join.tabela && chavesDir.has(c.campo))
          return cDoJoin.every((c) => {
            const chave = chavesDir.get(c.campo)!
            return c.operador === "in"
              ? c.valores.some((v) => valorIgual(v, j[chave]))
              : valorIgual(c.valores[0]!, j[chave])
          }) && valorIgual(j[join.chaveRemota], m.base[join.chaveLocal])
        })
        if (join.tipo === "inner") {
          if (matches.length === 0) continue // inner sem match → linha some
          for (const lado of matches) {
            proximas.push({ base: m.base, joins: { ...m.joins, [join.tabela]: lado } })
          }
        } else {
          // left: primeira linha casada (o join 1:1/1:N de FK única do
          // schema; sem match → null).
          proximas.push({
            base: m.base,
            joins: { ...m.joins, [join.tabela]: matches[0] ?? null },
          })
        }
      }
      materializadas.splice(0, materializadas.length, ...proximas)
    }

    // 3) Projeção do `select({ alias: tabela.coluna })` — fiel ao shape que
    //    o Drizzle devolve (alias → valor; coluna de leftJoin sem match → null).
    const projetadas =
      extra.projecao && extra.projecao.size > 0
        ? materializadas.map((m) => {
            const row = (t: Tabela) => (t === tabela ? m.base : (m.joins[t] ?? null))
            return Object.fromEntries(
              [...extra.projecao!.entries()].map(([alias, info]) => {
                const linha = row(info.tabela)
                return [alias, linha ? (linha[info.chave] ?? null) : null]
              }),
            )
          })
        : materializadas.map((m) => ({ ...m.base }))

    return {
      then: (
        res: (v: Array<Record<string, unknown>>) => unknown,
        rej?: (e: unknown) => void,
      ) => {
        try {
          res(projetadas)
        } catch (e) {
          rej?.(e)
        }
      },
    }
  }

  const db = {
    select: (
      cols: Record<string, { name?: string; table?: unknown }> = {},
    ) => {
      // Projeção alias → { chave camelCase, tabela dona da coluna }.
      const projecao = new Map<string, { chave: string; tabela: Tabela }>()
      for (const [alias, col] of Object.entries(cols ?? {})) {
        const nomeCol = (col as { name?: string })?.name
        if (!nomeCol) continue
        const tabelaCol = (col as { table?: Record<symbol, unknown> }).table?.[
          Symbol.for("drizzle:Name")
        ] as Tabela | undefined
        const dono = tabelaCol ?? TABELA_POR_COLUNA.get(nomeCol)
        if (!dono) continue
        const chave = (CHAVES_POR_TABELA.get(dono) ?? new Map()).get(nomeCol) ?? nomeCol
        projecao.set(alias, { chave, tabela: dono })
      }
      return {
        from: (tabelaBase: unknown) => {
          const base = nomeDaTabela(tabelaBase)
          const joins: JoinInfo[] = []
          const comJoin = {
            where: (cond: unknown) =>
              whereChain(base, cond, {
                joins,
                projecao: projecao.size > 0 ? projecao : null,
              }),
            innerJoin: (tDir: unknown, cond: unknown) => {
              joins.push(registrarJoin("inner", base, nomeDaTabela(tDir), cond))
              return comJoin
            },
            leftJoin: (tDir: unknown, cond: unknown) => {
              joins.push(registrarJoin("left", base, nomeDaTabela(tDir), cond))
              return comJoin
            },
          }
          return comJoin
        },
      }
    },
  }

  return { db: db as never }
}

// ============================================================================
// Fixtures / helpers
// ============================================================================

const PROJETO: ProjetoResumo = {
  id: 13,
  nome: "Gestão de Tarefas Global",
  slug: "gestao-de-tarefas-global",
  perfil: "admin",
}

/** Relógio fixo do servidor (2026-11-25 12:00:00 UTC — sem DST, dia limpo). */
const AGORA = new Date("2026-11-25T12:00:00Z")

const COLABORADORES: Array<Record<string, unknown>> = [
  { id: 7, organizacaoId: 10, nome: "Responsável Souza", ativo: true, usuarioId: 70 },
  { id: 9, organizacaoId: 10, nome: "Alvo Lima", ativo: true, usuarioId: 90 },
  { id: 21, organizacaoId: 10, nome: "Outra Pessoa", ativo: true, usuarioId: 210 },
  { id: 13, organizacaoId: 99, nome: "Colaborador Outra Org", ativo: true, usuarioId: 130 },
]

const AREAS: Array<Record<string, unknown>> = [
  { id: 1, organizacaoId: 10, nome: "Financeiro" },
  { id: 2, organizacaoId: 10, nome: "Operações" },
  { id: 3, organizacaoId: 10, nome: "Suporte" },
  { id: 50, organizacaoId: 99, nome: "Área Outra Org" },
]

const TAGS: Array<Record<string, unknown>> = [
  { id: 11, organizacaoId: 10, nome: "urgente-cliente" },
  { id: 12, organizacaoId: 10, nome: "interno" },
  { id: 60, organizacaoId: 99, nome: "Tag Outra Org" },
]

/**
 * Tarefas da organização 10 (a da sessão):
 * - T1: área 1, tag 11+12, aberta, prazo ONTEM (vencida)
 * - T2: área 1, tag 11, delegada, prazo HOJE (+6h, não vencida)
 * - T3: área 1, sem tag, precisa_informacoes, prazo +5d (semana)
 * - T4: área 2, tag 12, concluida, prazo -5d (NÃO conta p/ pendentes)
 * - T5: área 2, tag 11, cancelada, sem prazo (NÃO conta p/ nada)
 * - T6: área 3, tag 12, aberta, sem prazo (pendente, nunca vence)
 * - T7: área 2, tag 11+12, aguardando_terceiro, prazo +10d
 * - T8: área 3, sem tag, aberta, prazo = AGORA (fronteira: HOJE, não vencida)
 */
const TAREFAS_ORG: Array<Record<string, unknown>> = [
  { id: 1, organizacaoId: 10, titulo: "T1", areaId: 1, responsavelId: 7, prioridade: "urgente", status: "aberta", prazo: "2026-11-24 10:00:00" },
  { id: 2, organizacaoId: 10, titulo: "T2", areaId: 1, responsavelId: 9, prioridade: "alta", status: "delegada", prazo: "2026-11-25 18:00:00" },
  { id: 3, organizacaoId: 10, titulo: "T3", areaId: 1, responsavelId: 7, prioridade: "media", status: "precisa_informacoes", prazo: "2026-11-30 09:00:00" },
  { id: 4, organizacaoId: 10, titulo: "T4", areaId: 2, responsavelId: 7, prioridade: "baixa", status: "concluida", prazo: "2026-11-20 08:00:00" },
  { id: 5, organizacaoId: 10, titulo: "T5", areaId: 2, responsavelId: 9, prioridade: "media", status: "cancelada", prazo: null },
  { id: 6, organizacaoId: 10, titulo: "T6", areaId: 3, responsavelId: 21, prioridade: "alta", status: "aberta", prazo: null },
  { id: 7, organizacaoId: 10, titulo: "T7", areaId: 2, responsavelId: 7, prioridade: "baixa", status: "aguardando_terceiro", prazo: "2026-12-05 12:00:00" },
  { id: 8, organizacaoId: 10, titulo: "T8", areaId: 3, responsavelId: 9, prioridade: "urgente", status: "aberta", prazo: "2026-11-25 12:00:00" },
]

/** Tarefas de OUTRA organização (nunca podem aparecer). */
const TAREFAS_OUTRA_ORG: Array<Record<string, unknown>> = [
  { id: 90, organizacaoId: 99, titulo: "Outra Org T90", areaId: 50, responsavelId: 13, prioridade: "urgente", status: "aberta", prazo: "2026-11-01 00:00:00" },
]

const TAREFA_TAGS: Array<Record<string, unknown>> = [
  { id: 1, tarefaId: 1, tagId: 11 },
  { id: 2, tarefaId: 1, tagId: 12 },
  { id: 3, tarefaId: 2, tagId: 11 },
  { id: 4, tarefaId: 4, tagId: 12 },
  { id: 5, tarefaId: 5, tagId: 11 },
  { id: 6, tarefaId: 6, tagId: 12 },
  { id: 7, tarefaId: 7, tagId: 11 },
  { id: 8, tarefaId: 7, tagId: 12 },
  // Link de tarefa de outra org: nunca entra nas contagens.
  { id: 9, tarefaId: 90, tagId: 60 },
]

function fixtureBase(): Record<string, Array<Record<string, unknown>>> {
  return {
    tarefas: [...TAREFAS_ORG, ...TAREFAS_OUTRA_ORG],
    colaboradores: COLABORADORES,
    areas: AREAS,
    tags: TAGS,
    tarefa_tags: TAREFA_TAGS,
  }
}

function ctx(perfil: Perfil = "admin", colaboradorId = 7): ContextoSessao {
  return { organizacaoId: 10, colaboradorId, perfil }
}

function service(db: DbFakeApi, relogio: () => Date = () => AGORA): VisoesTarefasGlobalService {
  const factory = { obter: vi.fn(async () => db.db) } as unknown as ProjectDbFactory
  return new VisoesTarefasGlobalService(factory, relogio)
}

// ============================================================================
// contextoDaRequest (guards upstream — 403s)
// ============================================================================

describe("VisoesTarefasGlobalService — contexto da request", () => {
  const semDb = dbFake({})
  const svc = service(semDb)

  it("403 quando EscopoOrganizacaoGuard não executou (sem escopo)", () => {
    expect(() => svc.contextoDaRequest({} as never)).toThrow(ForbiddenException)
  })

  it("403 quando a sessão é master da plataforma (sem dados de negócio)", () => {
    expect(() =>
      svc.contextoDaRequest({
        escopoOrganizacao: { tipo: "master", usuarioId: 1 },
      } as never),
    ).toThrow(ForbiddenException)
  })

  it("contexto colaborador ativo → organizacaoId/colaboradorId/perfil", () => {
    const c = svc.contextoDaRequest({
      escopoOrganizacao: {
        tipo: "colaborador",
        organizacaoId: 10,
        colaboradorId: 7,
        perfil: "admin",
      },
    } as never)
    expect(c).toEqual({ organizacaoId: 10, colaboradorId: 7, perfil: "admin" })
  })
})

// ============================================================================
// GET /:slug/visoes/resumo
// ============================================================================

describe("VisoesTarefasGlobalService — resumo", () => {
  it("retorna EXATAMENTE as áreas e tags da org da sessão, com total/pendentes/vencidas corretas", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const resumo = await svc.resumo(PROJETO, ctx())

    // Áreas da org 10 (id 50 da org 99 NUNCA aparece) — ordenadas por nome.
    expect(resumo.areas.map((a) => a.id)).toEqual([1, 2, 3])
    expect(resumo.areas.map((a) => a.nome)).toEqual(["Financeiro", "Operações", "Suporte"])
    // Tags da org 10 (id 60 da org 99 NUNCA aparece) — ordenadas por nome:
    // "interno" (12) antes de "urgente-cliente" (11).
    expect(resumo.tags.map((t) => t.id)).toEqual([12, 11])

    // Financeiro (área 1): T1 (aberta, vencida), T2 (delegada), T3 (precisa_info)
    //   → total 3, pendentes 3, vencidas 1.
    expect(resumo.areas[0]).toEqual({
      id: 1,
      nome: "Financeiro",
      total: 3,
      pendentes: 3,
      vencidas: 1,
    })
    // Operações (área 2): T4 (concluida), T5 (cancelada), T7 (aguardando)
    //   → total 3, pendentes 1, vencidas 0 (T4 vencida MAS concluída).
    expect(resumo.areas[1]).toEqual({
      id: 2,
      nome: "Operações",
      total: 3,
      pendentes: 1,
      vencidas: 0,
    })
    // Suporte (área 3): T6 (aberta, sem prazo), T8 (aberta, prazo=agora)
    //   → total 2, pendentes 2, vencidas 0 (fronteira: prazo = agora NÃO é < agora).
    expect(resumo.areas[2]).toEqual({
      id: 3,
      nome: "Suporte",
      total: 2,
      pendentes: 2,
      vencidas: 0,
    })

    // Tag 12 (interno): T1, T4 (concluida), T6, T7 → total 4, pendentes 3,
    //   vencidas 1 (T1; T4 vencida mas concluída não conta).
    expect(resumo.tags[0]).toEqual({
      id: 12,
      nome: "interno",
      total: 4,
      pendentes: 3,
      vencidas: 1,
    })
    // Tag 11 (urgente-cliente): T1, T2, T5 (cancelada), T7 → total 4,
    //   pendentes 3 (T5 fora), vencidas 1 (T1).
    expect(resumo.tags[1]).toEqual({
      id: 11,
      nome: "urgente-cliente",
      total: 4,
      pendentes: 3,
      vencidas: 1,
    })
  })

  it("área/tag sem tarefas aparecem com zeros", async () => {
    const fixture = fixtureBase()
    // Área 3 sem tarefas: remove T6/T8 e sem links de tag.
    fixture.tarefas = (fixture.tarefas ?? []).filter((t) => Number(t.id) !== 6 && Number(t.id) !== 8)
    fixture.tarefa_tags = []
    const db = dbFake(fixture)
    const svc = service(db)

    const resumo = await svc.resumo(PROJETO, ctx())

    expect(resumo.areas).toContainEqual({
      id: 3,
      nome: "Suporte",
      total: 0,
      pendentes: 0,
      vencidas: 0,
    })
    for (const tag of resumo.tags) {
      expect(tag.total).toBe(0)
      expect(tag.pendentes).toBe(0)
      expect(tag.vencidas).toBe(0)
    }
  })

  it("vencidas usa o RELÓGIO DO SERVIDOR (prazo < agora) — tarefa sem prazo nunca vence", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    // Relógio ANTES de qualquer prazo pendente: zero vencidas em todo lugar.
    const antes = await service(db, () => new Date("2026-01-01T00:00:00Z")).resumo(
      PROJETO,
      ctx(),
    )
    for (const g of [...antes.areas, ...antes.tags]) expect(g.vencidas).toBe(0)

    // Relógio DEPOIS de todos os prazos: todas as pendentes vencem
    // (T1, T2, T3, T7, T8); T6 (sem prazo) NUNCA.
    const futuro = await service(db, () => new Date("2027-01-01T00:00:00Z")).resumo(
      PROJETO,
      ctx(),
    )
    // Financeiro: T1, T2, T3 vencem (3); Operações: só T7 (T4 concluída);
    // Suporte: T8 vence, T6 sem prazo NÃO.
    expect(futuro.areas[0]!.vencidas).toBe(3)
    expect(futuro.areas[1]!.vencidas).toBe(1)
    expect(futuro.areas[2]!.vencidas).toBe(1)
    // Tags (ordenadas por nome: 12 antes de 11): 12 → T1, T7 (2 — T6 sem
    // prazo, T4 concluída); 11 → T1, T2, T7 (3).
    expect(futuro.tags[0]!.vencidas).toBe(2)
    expect(futuro.tags[1]!.vencidas).toBe(3)
    void svc
  })

  it("isolamento: tarefa de outra org NUNCA entra nas contagens (mesma área/tag de id igual)", async () => {
    const fixture = fixtureBase()
    // Tarefa da org 99 na MESMA área (id 1) e com tag id 11 — idempotente p/
    // vazamento por id: sem filtro de organização ela inflaria as contagens.
    fixture.tarefas!.push({
      id: 91,
      organizacaoId: 99,
      titulo: "Vazamento potencial",
      areaId: 1,
      responsavelId: 13,
      prioridade: "urgente",
      status: "aberta",
      prazo: "2026-11-01 00:00:00",
    })
    fixture.tarefa_tags!.push({ id: 10, tarefaId: 91, tagId: 11 })
    const db = dbFake(fixture)
    const svc = service(db)

    const resumo = await svc.resumo(PROJETO, ctx())

    // Financeiro continua com T1, T2, T3 — a T91 (org 99, mesma área) não conta.
    expect(resumo.areas[0]).toEqual({
      id: 1,
      nome: "Financeiro",
      total: 3,
      pendentes: 3,
      vencidas: 1,
    })
    // Tag 12 (interno, tags[0] por nome) continua T1, T4, T6, T7.
    expect(resumo.tags[0]).toEqual({
      id: 12,
      nome: "interno",
      total: 4,
      pendentes: 3,
      vencidas: 1,
    })
    // Tag 11 (urgente-cliente, tags[1]) continua T1, T2, T5, T7 — T91, que
    // foi ligada à tag 11, NÃO conta (tarefa de outra org).
    expect(resumo.tags[1]).toEqual({
      id: 11,
      nome: "urgente-cliente",
      total: 4,
      pendentes: 3,
      vencidas: 1,
    })
  })

  it("sem linhas de nenhuma tabela → resumo vazio (org nova)", async () => {
    const db = dbFake({ tarefas: [], colaboradores: [], areas: [], tags: [], tarefa_tags: [] })
    const svc = service(db)

    const resumo = await svc.resumo(PROJETO, ctx())
    expect(resumo).toEqual({ areas: [], tags: [] })
  })

  it("404 quando o database do projeto está ausente", async () => {
    const factory = {
      obter: vi.fn(async () => {
        const erro = new Error("database inexistente") as Error & { code?: string }
        // Código do MySQL para banco não provisionado (ehErroDatabaseAusente).
        erro.code = "ER_BAD_DB_ERROR"
        throw erro
      }),
    } as unknown as ProjectDbFactory
    const svc = new VisoesTarefasGlobalService(factory, () => AGORA)
    await expect(svc.resumo(PROJETO, ctx())).rejects.toBeInstanceOf(NotFoundException)
  })
})

// ============================================================================
// GET /:slug/visoes/tarefas — por área
// ============================================================================

describe("VisoesTarefasGlobalService — tarefas por área", () => {
  it("areaId lista todas as tarefas da área com areaNome/responsavelNome resolvidos", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), { areaId: 1 })

    expect(total).toBe(3)
    expect(items.map((i) => i.id)).toEqual([1, 2, 3])
    expect(items[0]).toEqual({
      id: 1,
      titulo: "T1",
      descricao: null,
      prioridade: "urgente",
      prazo: "2026-11-24 10:00:00",
      status: "aberta",
      areaId: 1,
      areaNome: "Financeiro",
      responsavelId: 7,
      responsavelNome: "Responsável Souza",
    })
  })

  it("área de OUTRA organização → vazia (isolamento, sem vazamento)", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), { areaId: 50 })
    expect(items).toEqual([])
    expect(total).toBe(0)
  })

  it("ordenação padrão: prazo ASC com NULL por último + prioridade DESC + id ASC", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items } = await svc.tarefasDaVisao(PROJETO, ctx(), { areaId: 3 })
    // Área 3: T6 (sem prazo), T8 (prazo=agora).
    expect(items.map((i) => i.id)).toEqual([8, 6])

    const { items: todasOperacoes } = await svc.tarefasDaVisao(PROJETO, ctx(), { areaId: 2 })
    // Operações: T4 (2026-11-20), T5 (sem prazo), T7 (2026-12-05)
    //   → T4 primeiro (prazo menor), T7 (prazo futuro), T5 (NULL por último).
    expect(todasOperacoes.map((i) => i.id)).toEqual([4, 7, 5])

    // Desempate por prioridade: T2 (alta) e T3 (media) com o MESMO prazo
    //   → alta antes de media (DESC).
    const fixture = fixtureBase()
    fixture.tarefas = (fixture.tarefas ?? []).map((t) =>
      Number(t.id) === 3 ? { ...t, prazo: "2026-11-25 18:00:00" } : t,
    )
    const { items: area1 } = await service(dbFake(fixture)).tarefasDaVisao(
      PROJETO,
      ctx(),
      { areaId: 1 },
    )
    // T1 (urgente, prazo=ontem), T2 (alta, +6h), T3 (media, mesmo prazo de T2)
    //   → T1 (prazo menor), depois T2 (alta > media no empate), T3.
    expect(area1.map((i) => i.id)).toEqual([1, 2, 3])
  })
})

// ============================================================================
// GET /:slug/visoes/tarefas — por tag (JOIN M:N)
// ============================================================================

describe("VisoesTarefasGlobalService — tarefas por tag (JOIN M:N)", () => {
  it("tagId lista apenas tarefas VINCULADAS via tarefa_tags, sem duplicatas", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    // Tag 12 (interno): T1 (2026-11-24), T4 (2026-11-20), T6 (sem prazo),
    // T7 (2026-12-05) — ordenação prazo ASC NULL último: [4, 1, 7, 6].
    // T7 tem 2 tags (11+12) e aparece UMA única vez na tag 12.
    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), { tagId: 12 })
    expect(total).toBe(4)
    expect(items.map((i) => i.id)).toEqual([4, 1, 7, 6])
    // Sem duplicata de id.
    const ids = items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("tag de OUTRA organização → vazia (isolamento via JOIN escopado)", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    // Tag 60 (org 99) está ligada à T90 (org 99) — sem vazamento.
    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), { tagId: 60 })
    expect(items).toEqual([])
    expect(total).toBe(0)
  })

  it("JOIN M:N: tarefa com 2 tags aparece nas duas visões, uma vez cada", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const por11 = await svc.tarefasDaVisao(PROJETO, ctx(), { tagId: 11 })
    const por12 = await svc.tarefasDaVisao(PROJETO, ctx(), { tagId: 12 })
    expect(por11.items.map((i) => i.id)).toContain(7)
    expect(por12.items.map((i) => i.id)).toContain(7)
    expect(por11.items.filter((i) => i.id === 7)).toHaveLength(1)
    expect(por12.items.filter((i) => i.id === 7)).toHaveLength(1)
  })
})

// ============================================================================
// Filtros combináveis: status (multi) + prazo (bucket) + responsavelId
// ============================================================================

describe("VisoesTarefasGlobalService — filtros combináveis", () => {
  it("status multi (array) filtra exatamente os status pedidos", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), {
      areaId: 1,
      status: ["delegada", "precisa_informacoes"],
    })
    // Área 1: T1 (aberta), T2 (delegada), T3 (precisa_info) → T2, T3.
    expect(total).toBe(2)
    expect(items.map((i) => i.id).sort((a, b) => a - b)).toEqual([2, 3])
  })

  it("bucket prazo=vencida (prazo < agora) independente de status", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), {
      areaId: 2,
      prazo: "vencida",
    })
    // Operações: T4 (2026-11-20 < agora) e T7 (2026-12-05 ≥ agora) → só T4
    // (bucket 'vencida' não exclui concluídas — combine com `status`).
    expect(total).toBe(1)
    expect(items[0]!.id).toBe(4)
  })

  it("bucket prazo=hoje (agora ≤ prazo ≤ agora+24h)", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), {
      areaId: 1,
      prazo: "hoje",
    })
    // Área 1: T1 (ontem), T2 (2026-11-25 18:00 → +6h), T3 (+5d) → só T2.
    expect(total).toBe(1)
    expect(items[0]!.id).toBe(2)
  })

  it("bucket prazo=semana (agora ≤ prazo ≤ agora+7d)", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), {
      tagId: 12,
      prazo: "semana",
    })
    // Tag 12: T1 (ontem), T4 (ontem), T6 (sem prazo), T7 (+10d) → nenhum no
    // intervalo → vazio.
    expect(total).toBe(0)
    expect(items).toEqual([])

    // Com a área 1: T2 (+6h) e T3 (+5d) estão na semana.
    const area1 = await svc.tarefasDaVisao(PROJETO, ctx(), {
      areaId: 1,
      prazo: "semana",
    })
    expect(area1.items.map((i) => i.id).sort((a, b) => a - b)).toEqual([2, 3])
  })

  it("bucket prazo=sem_prazo (prazo IS NULL)", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), {
      areaId: 2,
      prazo: "sem_prazo",
    })
    // Operações: T4 (tem prazo), T5 (sem), T7 (tem) → só T5.
    expect(total).toBe(1)
    expect(items[0]!.id).toBe(5)
  })

  it("responsavelId combina com areaId + status + prazo (todos juntos)", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { items, total } = await svc.tarefasDaVisao(PROJETO, ctx(), {
      areaId: 1,
      status: ["aberta"],
      prazo: "vencida",
      responsavelId: 7,
    })
    // Área 1 + aberta + vencida + resp. 7 → T1.
    expect(total).toBe(1)
    expect(items[0]!.id).toBe(1)

    // Trocando o responsável → vazio.
    const outro = await svc.tarefasDaVisao(PROJETO, ctx(), {
      areaId: 1,
      status: ["aberta"],
      prazo: "vencida",
      responsavelId: 9,
    })
    expect(outro.total).toBe(0)
  })

  it("sem filtros: retorna TODAS as tarefas da área (qualquer status)", async () => {
    const db = dbFake(fixtureBase())
    const svc = service(db)

    const { total } = await svc.tarefasDaVisao(PROJETO, ctx(), { areaId: 2 })
    expect(total).toBe(3)
  })
})

// ============================================================================
// pertenceBucket (função pura exportada)
// ============================================================================

describe("pertenceBucket (função pura)", () => {
  it("vencida: prazo < agora (fronteira: = agora → NÃO)", () => {
    expect(pertenceBucket("vencida", "2026-11-25 11:59:59", AGORA)).toBe(true)
    expect(pertenceBucket("vencida", "2026-11-25 12:00:00", AGORA)).toBe(false)
    expect(pertenceBucket("vencida", null, AGORA)).toBe(false)
  })

  it("hoje: agora ≤ prazo ≤ agora+24h (fronteiras inclusivas)", () => {
    expect(pertenceBucket("hoje", "2026-11-25 12:00:00", AGORA)).toBe(true)
    expect(pertenceBucket("hoje", "2026-11-26 12:00:00", AGORA)).toBe(true)
    expect(pertenceBucket("hoje", "2026-11-26 12:00:01", AGORA)).toBe(false)
    expect(pertenceBucket("hoje", "2026-11-25 11:59:59", AGORA)).toBe(false)
    expect(pertenceBucket("hoje", null, AGORA)).toBe(false)
  })

  it("semana: agora ≤ prazo ≤ agora+7d (fronteiras inclusivas)", () => {
    expect(pertenceBucket("semana", "2026-12-02 12:00:00", AGORA)).toBe(true)
    expect(pertenceBucket("semana", "2026-12-02 12:00:01", AGORA)).toBe(false)
    expect(pertenceBucket("semana", null, AGORA)).toBe(false)
  })

  it("sem_prazo: prazo NULL (e somente NULL)", () => {
    expect(pertenceBucket("sem_prazo", null, AGORA)).toBe(true)
    expect(pertenceBucket("sem_prazo", "2026-11-25 00:00:00", AGORA)).toBe(false)
  })
})

// ============================================================================
// DTO — validação da query (GET /:slug/visoes/tarefas)
// ============================================================================

describe("visoesTarefasQuerySchema (validação da query)", () => {
  it("aceita área OU tag (cada um isolado) e sem filtros", () => {
    expect(visoesTarefasQuerySchema.parse({ areaId: "1" }).areaId).toBe(1)
    expect(visoesTarefasQuerySchema.parse({ tagId: "11" }).tagId).toBe(11)
    expect(visoesTarefasQuerySchema.parse({})).toEqual({})
  })

  it("rejeita areaId E tagId ao mesmo tempo", () => {
    const r = visoesTarefasQuerySchema.safeParse({ areaId: "1", tagId: "11" })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("areaId"))).toBe(true)
    }
  })

  it("status aceita CSV E query repetida; rejeita valor inválido", () => {
    expect(
      visoesTarefasQuerySchema.parse({ areaId: "1", status: "aberta,delegada" }).status,
    ).toEqual(["aberta", "delegada"])
    expect(
      visoesTarefasQuerySchema.parse({ areaId: "1", status: ["aberta", "delegada"] }).status,
    ).toEqual(["aberta", "delegada"])
    const invalido = visoesTarefasQuerySchema.safeParse({ areaId: "1", status: "inexistente" })
    expect(invalido.success).toBe(false)
  })

  it("prazo só aceita os buckets válidos", () => {
    for (const b of bucketPrazoValues) {
      expect(visoesTarefasQuerySchema.parse({ areaId: "1", prazo: b }).prazo).toBe(b)
    }
    expect(
      visoesTarefasQuerySchema.safeParse({ areaId: "1", prazo: "amanehecer" }).success,
    ).toBe(false)
  })

  it("ids: numéricos aceitos, vazios → ausente, não-numéricos → erro", () => {
    expect(visoesTarefasQuerySchema.parse({ areaId: "42" }).areaId).toBe(42)
    expect(visoesTarefasQuerySchema.parse({ areaId: "" })).toEqual({})
    expect(visoesTarefasQuerySchema.safeParse({ areaId: "abc" }).success).toBe(false)
    expect(visoesTarefasQuerySchema.safeParse({ areaId: "-1" }).success).toBe(false)
    expect(visoesTarefasQuerySchema.safeParse({ responsavelId: "0" }).success).toBe(false)
  })

  it("statusTarefaValues espelha o enum do schema (6 status)", () => {
    expect([...statusTarefaValues].sort()).toEqual([
      "aberta",
      "aguardando_terceiro",
      "cancelada",
      "concluida",
      "delegada",
      "precisa_informacoes",
    ])
  })
})
