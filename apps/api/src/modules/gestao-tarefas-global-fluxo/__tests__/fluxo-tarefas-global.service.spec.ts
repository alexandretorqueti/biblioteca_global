// @vitest-environment node
/**
 * Testes unitários do FluxoTarefasGlobalService (gestao-de-tarefas-global —
 * macro #3, subtarefa 2): endpoints custom de fluxo (delegar/devolver/
 * concluir/cancelar) + chat + histórico.
 *
 * Estratégia: db fake encadeável (padrão dos specs de escopo/ocorrências) —
 * nenhuma dependência de MySQL. As condições de `where` são RENDERIZADAS
 * pelo dialect Drizzle real (sqlToQuery) e avaliadas contra as linhas-
 * fixture: o fake é fiel ao SQL efetivamente executado.
 *
 * Cobre:
 * - transições persistidas (tarefa + histórico na mesma transação);
 * - histórico de/para (delegacao/reatribuicao/devolucao_* / mudanca_status);
 * - rejeições 404 (tarefa de outra organização), 403 (autorização) e
 *   409 (transição inválida) com mensagem clara;
 * - devolver: sabor + mensagem obrigatória, concluída preenche concluidaEm;
 * - chat: POST grava autorId da SESSÃO (nunca do body) e GET retorna
 *   autor (nome) + data;
 * - realtime: task.status.changed nas transições e chat.message.created no
 *   envio (eventId uuid, projectId do token, taskId);
 * - notificações do sino (macro #5, subtarefa 2): delegação/devolução
 *   inseridas na MESMA transição + push notification.created pós-commit.
 */
import { describe, expect, it, vi } from "vitest"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { Perfil, ProjetoResumo } from "@biblioteca-global/shared"
import * as schemaGestao from "../../../../../../projects/gestao-de-tarefas-global/schema"
import type { ProjectDbFactory } from "../../crud/project-db.factory"
import { NotificacoesService } from "../../gestao-tarefas-global-notificacoes/notificacoes.service"
import {
  FluxoTarefasGlobalService,
  type ContextoSessao,
} from "../fluxo-tarefas-global.service"

// ============================================================================
// Fake de banco (encadeável, fiel ao SQL renderizado)
// ============================================================================

type Tabela =
  | "tarefas"
  | "colaboradores"
  | "historico_tarefas"
  | "mensagens_tarefa"
  | "areas"
  | "tags"
  | "organizacoes"
  | "regras_recorrencia"
  | "tarefa_tags"
  | "anexos"
  | "notificacoes"

interface InsertChamada {
  tabela: Tabela
  valores: Record<string, unknown>
}

interface UpdateChamada {
  tabela: Tabela
  set: Record<string, unknown>
  condicoes: Array<{ campo: string; valor: unknown }>
}

interface EventoTransacao {
  inicio: boolean
  fim: boolean
  erro: unknown
}

interface DbFakeApi {
  db: unknown
  insercoes: InsertChamada[]
  updates: UpdateChamada[]
  transacoes: EventoTransacao[]
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
    // Wrapper `and(...)`/`sql` do Drizzle não expõe toSQL — renderiza pelo
    // dialect real (mesmo padrão de gestao-tarefas-global-escopo.spec.ts).
    const r = dialect.sqlToQuery(cond as never)
    sql = r.sql
    params = r.params as unknown[]
  }
  // O dialect mantém referências de coluna como parâmetros (`? = ?`);
  // inline-as como `` `col` = ? `` para a extração de condições — os params
  // finais passam a ser apenas os VALORES, na ordem dos placeholders `?`.
  const paramsFinais: unknown[] = []
  const iter = params[Symbol.iterator]()
  sql = sql.replace(/\?/g, () => {
    const { value, done } = iter.next()
    const maybeCol = value as { name?: unknown; tableName?: unknown } | null
    if (
      !done &&
      maybeCol &&
      typeof maybeCol === "object" &&
      typeof maybeCol.name === "string" &&
      typeof maybeCol.tableName === "string"
    ) {
      return `\`${maybeCol.name}\``
    }
    paramsFinais.push(value)
    return "?"
  })
  return { sql, params: paramsFinais }
}

/**
 * Extrai condições simples (`col = ?` / `col IN (?, ...)`) do SQL renderizado.
 * Suficiente para as queries deste service (sem JOINs/subconsultas).
 */
function extrairCondicoes(sql: string, params: unknown[]): Array<{ campo: string; operador: "=" | "in"; valores: unknown[] }> {
  const condicoes: Array<{ campo: string; operador: "=" | "in"; valores: unknown[] }> = []
  // `col` IN (?, ?, ?) — o dialect renderiza `in` minúsculo.
  const reIn = /`(\w+)` IN \(([^)]*)\)/gi
  const offsetsIn: Array<{ campo: string; inicio: number; params: unknown[] }> = []
  let mIn: RegExpExecArray | null
  while ((mIn = reIn.exec(sql)) !== null) {
    const marcadores = (mIn[2]!.match(/\?/g) ?? []).length
    const inicio = sql.slice(0, mIn.index).split("?").length - 1
    offsetsIn.push({
      campo: mIn[1]!,
      inicio,
      params: params.slice(inicio, inicio + marcadores),
    })
  }
  // `col` = ?  (fora das regiões IN já capturadas)
  const reEq = /`(\w+)` = \?/g
  const offsetsEq: Array<{ campo: string; inicio: number }> = []
  let mEq: RegExpExecArray | null
  while ((mEq = reEq.exec(sql)) !== null) {
    const inicio = sql.slice(0, mEq.index).split("?").length - 1
    if (offsetsIn.some((o) => inicio >= o.inicio && inicio < o.inicio + o.params.length)) {
      continue
    }
    offsetsEq.push({ campo: mEq[1]!, inicio })
  }
  offsetsIn.forEach((o) => condicoes.push({ campo: o.campo, operador: "in", valores: o.params }))
  offsetsEq.forEach((o) => condicoes.push({ campo: o.campo, operador: "=", valores: [params[o.inicio]] }))
  return condicoes
}

function linhasDe(tabela: Tabela, fixture: Record<string, Array<Record<string, unknown>>>): Array<Record<string, unknown>> {
  return fixture[tabela] ?? []
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
  /** Tabela do lado direito do leftJoin (ex.: "areas"). */
  tabela: Tabela
  /** Chave camelCase da fixture na tabela esquerda (ex.: areaId). */
  chaveLocal: string
  /** Chave camelCase da fixture na tabela direita (ex.: id). */
  chaveRemota: string
}

/**
 * leftJoin com condição `eq(colEsq, colDir)`: o dialect renderiza as duas
 * referências de coluna inlinadas (`` `area_id` = `id` ``) — extrai os dois
 * nomes e mapeia para as chaves camelCase das fixtures.
 */
function registrarJoin(
  tabelaEsq: Tabela,
  tabelaDir: Tabela,
  cond: unknown,
): JoinInfo {
  const { sql } = renderizar(cond as never)
  // Dialect renderiza `` `tarefas`.`area_id` = `areas`.`id` `` — captura
  // tabela.coluna de cada lado; as COLUNAS são os grupos 2 e 4.
  const m = sql.match(/`(\w+)`\.`(\w+)`\s*=\s*`(\w+)`\.`(\w+)`/)
  if (!m) {
    const s = sql.match(/`(\w+)`\s*=\s*`(\w+)`/)
    if (!s) throw new Error(`condição de join não suportada no fake: ${sql}`)
    const chavesEsq = CHAVES_POR_TABELA.get(tabelaEsq) ?? new Map()
    const chavesDir = CHAVES_POR_TABELA.get(tabelaDir) ?? new Map()
    return {
      tabela: tabelaDir,
      chaveLocal: chavesEsq.get(s[1]!) ?? s[1]!,
      chaveRemota: chavesDir.get(s[2]!) ?? s[2]!,
    }
  }
  const chavesEsq = CHAVES_POR_TABELA.get(tabelaEsq) ?? new Map()
  const chavesDir = CHAVES_POR_TABELA.get(tabelaDir) ?? new Map()
  return {
    tabela: tabelaDir,
    chaveLocal: chavesEsq.get(m[2]!) ?? m[2]!,
    chaveRemota: chavesDir.get(m[4]!) ?? m[4]!,
  }
}

function avaliar(
  tabela: Tabela,
  fixture: Record<string, Array<Record<string, unknown>>>,
  condSql: string,
  condParams: unknown[],
): Array<Record<string, unknown>> {
  const chaves = CHAVES_POR_TABELA.get(tabela) ?? new Map()
  const condicoes = extrairCondicoes(condSql, condParams)
  return linhasDe(tabela, fixture).filter((linha) =>
    condicoes.every((cond) => {
      const chave = chaves.get(cond.campo)
      if (!chave) throw new Error(`coluna desconhecida no fake: ${tabela}.${cond.campo}`)
      const valor = linha[chave]
      return cond.operador === "in"
        ? cond.valores.some((v) => valorIgual(v, valor))
        : valorIgual(cond.valores[0], valor)
    }),
  )
}

function dbFake(
  fixture: Record<string, Array<Record<string, unknown>>>,
): DbFakeApi {
  const insercoes: InsertChamada[] = []
  const updates: UpdateChamada[] = []
  const transacoes: EventoTransacao[] = []
  let proximoId = 10_000

  const whereChain = (
    tabela: Tabela,
    cond: unknown,
    extra: { joins: JoinInfo[]; projecao: Map<string, string> | null } = { joins: [], projecao: null },
  ) => {
    const { sql: condSql, params: condParams } = renderizar(cond as never)
    let linhas = avaliar(tabela, fixture, condSql, condParams)
    // leftJoin fiel ao SQL: linha casada soma as colunas do lado direito;
    // sem match as colunas do join ficam NULL (projeção mapeia undefined→null).
    for (const join of extra.joins) {
      linhas = linhas.map((linha) => {
        const lado = (fixture[join.tabela] ?? []).find(
          (j) => valorIgual(j[join.chaveRemota], linha[join.chaveLocal]),
        )
        if (!lado) return linha
        const mesclada = { ...linha }
        for (const [k, v] of Object.entries(lado)) {
          if (!(k in mesclada)) mesclada[k] = v
        }
        return mesclada
      })
    }
    // Projeção do `select({ alias: tabela.coluna })` — fiel ao shape que o
    // Drizzle devolve (alias → valor; coluna ausente no leftJoin → null).
    const projetadas =
      extra.projecao && extra.projecao.size > 0
        ? linhas.map((l) =>
            Object.fromEntries(
              [...extra.projecao!.entries()].map(([alias, chave]) => [
                alias,
                l[chave] ?? null,
              ]),
            ),
          )
        : linhas
    return {
      limit: async () => projetadas,
      // Fiel ao Drizzle: `select().from().where()` SEM limit/orderBy é um
      // builder awaitável — resolve direto para as linhas (nomesColaboradores
      // usa exatamente esse encadeamento).
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
      // ORDER BY fiel: extrai (coluna, direção) de cada expressão e ordena
      // as linhas — os GETs de histórico/chat dependem da ordem real.
      // Suporta também as expressões do dashboard pessoal (minhasTarefas):
      // `col IS NULL` (nulls last) e `CASE col WHEN 'x' THEN n ... END` (ranking).
      orderBy: (...ords: unknown[]) => {
        const chaves = CHAVES_POR_TABELA.get(tabela) ?? new Map()
        const criterios = ords.map((o) => {
          const { sql: osql } = renderizar(o as never)
          // O dialect renderiza `` `tabela`.`coluna` asc `` — a COLUNA é o
          // último identificador entre backticks (o primeiro é a tabela).
          const backticks = osql.match(/`(\w+)`/g) ?? []
          const campo = (backticks[backticks.length - 1] ?? "").replace(/`/g, "")
          const dir = /\bdesc\b/i.test(osql) ? -1 : 1
          const chave = chaves.get(campo) ?? campo
          if (/\bIS NULL\b/i.test(osql)) {
            // `(col IS NULL) ASC` → 0 para não-nulos, 1 para NULLs (last).
            return { tipo: "isNull" as const, chave, dir, mapa: null as Map<string, number> | null }
          }
          if (/\bCASE\b/i.test(osql)) {
            const mapa = new Map<string, number>()
            const reWhen = /WHEN '([^']*)' THEN (\d+)/gi
            let mw: RegExpExecArray | null
            while ((mw = reWhen.exec(osql)) !== null) {
              mapa.set(mw[1]!, Number(mw[2]!))
            }
            return { tipo: "case" as const, chave, dir, mapa }
          }
          return { tipo: "valor" as const, chave, dir, mapa: null as Map<string, number> | null }
        })
        // Normalização de valores ordenáveis: Date/number direto; string
        // numérica → número; string datada (ISO) → epoch; null → NaN.
        const normalizar = (v: unknown): number => {
          if (v == null) return NaN
          if (v instanceof Date) return v.getTime()
          if (typeof v === "number") return v
          const n = Number(v)
          if (Number.isFinite(n)) return n
          const t = Date.parse(String(v))
          return Number.isFinite(t) ? t : NaN
        }
        const valorOrd = (linha: Record<string, unknown>, c: (typeof criterios)[number]): number => {
          const v = linha[c.chave]
          if (c.tipo === "isNull") return v == null ? 1 : 0
          if (c.tipo === "case") {
            return c.mapa!.get(String(v)) ?? Number.MAX_SAFE_INTEGER
          }
          return normalizar(v)
        }
        const ordenadas = [...projetadas].sort((a, b) => {
          for (const c of criterios) {
            const ka = valorOrd(a, c)
            const kb = valorOrd(b, c)
            if (Number.isNaN(ka) || Number.isNaN(kb)) {
              // Ambos nulos → critério seguinte decide; um nulo → por último
              // (nulls-last vem do critério IS NULL; coerente com ASC no SQL).
              if (Number.isNaN(ka) && Number.isNaN(kb)) continue
              return (Number.isNaN(ka) ? 1 : -1) * c.dir
            }
            if (ka !== kb) return (ka > kb ? 1 : -1) * c.dir
          }
          return 0
        })
        // Encadeamento Drizzle: after where/orderBy vem .limit(); o próprio
        // orderBy também é awaitável (resolve para as linhas ordenadas).
        const thenable = Object.assign(async () => ordenadas, {
          limit: async () => ordenadas,
          orderBy: () => thenable,
          then: (res: (v: unknown[]) => unknown) => res(ordenadas),
        })
        return thenable
      },
    }
  }

  const db = {
    select: (cols?: Record<string, { name?: string; table?: unknown }>) => {
      // Projeção alias → chave camelCase da fixture: o Drizzle devolve o
      // shape do select object (ex.: areaNome = areas.nome no leftJoin).
      const projecao = new Map<string, string>()
      for (const [alias, col] of Object.entries(cols ?? {})) {
        const nomeCol = (col as { name?: string })?.name
        if (!nomeCol) continue
        const tabelaCol = (col as { table?: Record<symbol, unknown> }).table?.[
          Symbol.for("drizzle:Name")
        ] as string | undefined
        const chavesCol = CHAVES_POR_TABELA.get((tabelaCol ?? "?") as Tabela)
        projecao.set(alias, chavesCol?.get(nomeCol) ?? nomeCol)
      }
      return {
        from: (tabela: unknown) => {
          const joins: JoinInfo[] = []
          const extra = { joins, projecao: projecao.size > 0 ? projecao : null }
          const comJoin = {
            where: (cond: unknown) => whereChain(nomeDaTabela(tabela), cond, extra),
            leftJoin: (tDir: unknown, cond: unknown) => {
              joins.push(
                registrarJoin(nomeDaTabela(tabela), nomeDaTabela(tDir), cond),
              )
              return comJoin
            },
            // select(...).from(tabela).orderBy(...) sem where (não usado aqui,
            // mas mantém o encadeamento completo do Drizzle).
            orderBy: (...ords: unknown[]) =>
              whereChain(nomeDaTabela(tabela), undefined as never, extra).orderBy(...ords),
          }
          return comJoin
        },
      }
    },
    update: (tabela: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const { sql: condSql, params: condParams } = renderizar(cond as never)
          const condicoes = extrairCondicoes(condSql, condParams)
          void condicoes
          return Promise.resolve().then(() => {
            const chaves = CHAVES_POR_TABELA.get(nomeDaTabela(tabela)) ?? new Map()
            updates.push({
              tabela: nomeDaTabela(tabela),
              set,
              condicoes: condicoes.map((c) => ({
                campo: chaves.get(c.campo) ?? c.campo,
                valor: c.valores[0],
              })),
            })
            return []
          })
        },
        // Drizzle permite orderBy após set+where (ex.: ordenar antes do
        // update); o fake não precisa ordenar — só aceitar o encadeamento.
        orderBy: () => Promise.resolve([]),
      }),
    }),
    insert: (tabela: unknown) => ({
      values: (valores: Record<string, unknown>) =>
        Promise.resolve().then(() => {
          proximoId += 1
          insercoes.push({ tabela: nomeDaTabela(tabela), valores })
          return [{ insertId: proximoId }]
        }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      transacoes.push({ inicio: true, fim: false, erro: null })
      try {
        const resultado = await fn(db)
        transacoes[transacoes.length - 1]!.fim = true
        return resultado
      } catch (erro) {
        transacoes[transacoes.length - 1]!.erro = erro
        throw erro
      }
    },
  }

  return { db: db as never, insercoes, updates, transacoes }
}

// ============================================================================
// Fixtures
// ============================================================================

const PROJETO: ProjetoResumo = {
  id: 13,
  nome: "Gestão de Tarefas Global",
  slug: "gestao-de-tarefas-global",
  perfil: "admin",
}

const TAREFA: Record<string, unknown> = {
  id: 42,
  organizacaoId: 10,
  titulo: "Tarefa teste",
  responsavelId: 7,
  criadoPorId: 5,
  status: "aberta",
}

const COLABORADORES: Array<Record<string, unknown>> = [
  { id: 5, organizacaoId: 10, nome: "Criador Silva", ativo: true },
  { id: 7, organizacaoId: 10, nome: "Responsável Souza", ativo: true },
  { id: 9, organizacaoId: 10, nome: "Alvo Lima", ativo: true },
  { id: 11, organizacaoId: 10, nome: "Inativo Costa", ativo: false },
  { id: 13, organizacaoId: 99, nome: "Outra Org", ativo: true },
]

function ctx(perfil: Perfil = "admin", colaboradorId = 7): ContextoSessao {
  return { organizacaoId: 10, colaboradorId, perfil }
}

function realtimeFake() {
  const eventos: Array<Record<string, unknown>> = []
  const publicar = vi.fn((evento: unknown) => {
    eventos.push(evento as Record<string, unknown>)
    return { eventId: (evento as { eventId: string }).eventId, sequence: 1 }
  })
  // Espelha RealtimeService.publicarNotificacoes: mesmo registro no `eventos`
  // (o evento real carrega type/sequence/eventId; o fake guarda o input).
  const publicarNotificacoes = vi.fn((input: Record<string, unknown>) => {
    eventos.push({ ...input, canal: "notifications" })
  })
  return { realtime: { publicar, publicarNotificacoes } as never, eventos }
}

function service(db: DbFakeApi, realtime?: { publicar: (e: unknown) => unknown }) {
  const factory = { obter: vi.fn(async () => db.db) } as unknown as ProjectDbFactory
  const rt = (realtime ?? realtimeFake().realtime) as never
  return new FluxoTarefasGlobalService(
    factory,
    rt,
    new NotificacoesService(factory, rt),
  )
}

// ============================================================================
// Delegar
// ============================================================================

describe("FluxoTarefasGlobalService — delegar", () => {
  it("troca o responsável único, grava histórico delegacao (de/para) e publica task.status.changed", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)
    const eventos = rt.eventos

    const resultado = await svc.delegar(PROJETO, ctx("admin"), 42, { responsavelId: 9 })

    expect(resultado.status).toBe("delegada")
    expect(resultado.responsavelId).toBe(9)
    expect(resultado.concluidaEm).toBeNull()
    expect(resultado.evento.tipoEvento).toBe("delegacao")
    expect(resultado.evento.deColaboradorId).toBe(7)
    expect(resultado.evento.paraColaboradorId).toBe(9)

    // Tarefa atualizada e histórico inserido NA MESMA transação (atômico).
    expect(db.updates).toHaveLength(1)
    expect(db.updates[0]!.tabela).toBe("tarefas")
    expect(db.updates[0]!.set).toEqual({ status: "delegada", responsavelId: 9 })
    expect(db.updates[0]!.condicoes).toEqual([{ campo: "id", valor: 42 }])
    const hist = db.insercoes.filter((i) => i.tabela === "historico_tarefas")
    expect(hist).toHaveLength(1)
    expect(hist[0]!.valores).toMatchObject({
      tarefaId: 42,
      tipoEvento: "delegacao",
      deColaboradorId: 7,
      paraColaboradorId: 9,
    })
    expect(db.transacoes).toEqual([{ inicio: true, fim: true, erro: null }])

    // Realtime: task.status.changed com eventId uuid + projectId do token + taskId.
    expect(eventos).toHaveLength(1)
    const evento = eventos[0]!
    expect(evento.type).toBe("task.status.changed")
    expect(evento.projectId).toBe(13)
    expect(evento.taskId).toBe(42)
    expect(evento.payload).toEqual({ previousStatus: "aberta", status: "delegada" })
    expect(evento.eventId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("re-delegação em cadeia grava reatribuicao (de = ex-responsável, para = novo)", async () => {
    const tarefaDelegada = { ...TAREFA, status: "delegada", responsavelId: 9 }
    const db = dbFake({ tarefas: [tarefaDelegada], colaboradores: COLABORADORES })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)
    const eventos = rt.eventos

    const resultado = await svc.delegar(PROJETO, ctx("admin"), 42, { responsavelId: 7 })
    expect(resultado.evento.tipoEvento).toBe("reatribuicao")
    expect(resultado.evento.deColaboradorId).toBe(9)
    expect(resultado.evento.paraColaboradorId).toBe(7)
    expect(eventos[0]!.type).toBe("task.status.changed")
    expect(eventos[0]!.payload).toEqual({ previousStatus: "delegada", status: "delegada" })
  })

  it("409 claro: delegar para o próprio responsável atual", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)
    // Autor é admin (autorizado) mas o alvo é o responsável atual.
    await expect(
      svc.delegar(PROJETO, ctx("admin", 7), 42, { responsavelId: 7 }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      svc.delegar(PROJETO, ctx("admin", 7), 42, { responsavelId: 7 }),
    ).rejects.toThrow(/diferente do responsável atual/)
    expect(db.updates).toHaveLength(0)
    expect(db.insercoes).toHaveLength(0)
  })

  it("400: responsável-alvo inativo", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)
    await expect(
      svc.delegar(PROJETO, ctx("admin"), 42, { responsavelId: 11 }),
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      svc.delegar(PROJETO, ctx("admin"), 42, { responsavelId: 11 }),
    ).rejects.toThrow(/não existe nesta organização/)
  })

  it("400: responsável-alvo de outra organização (isolamento)", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)
    await expect(
      svc.delegar(PROJETO, ctx("admin"), 42, { responsavelId: 13 }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(db.insercoes).toHaveLength(0)
  })
})

// ============================================================================
// Devolver / Concluir
// ============================================================================

describe("FluxoTarefasGlobalService — devolver/concluir", () => {
  it("devolução sabor precisa_informacoes: atualiza status, grava devolucao_precisa_info com mensagem", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const db = dbFake({ tarefas: [tarefa], colaboradores: COLABORADORES })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)
    const eventos = rt.eventos

    const resultado = await svc.devolver(PROJETO, ctx("admin", 7), 42, {
      sabor: "precisa_informacoes",
      mensagem: "Falta o código do cliente.",
    })
    expect(resultado.status).toBe("precisa_informacoes")
    expect(resultado.concluidaEm).toBeNull()
    expect(resultado.evento.tipoEvento).toBe("devolucao_precisa_info")
    expect(resultado.evento.deColaboradorId).toBe(7)
    expect(resultado.evento.paraColaboradorId).toBeNull()
    expect(db.updates[0]!.set).toEqual({
      status: "precisa_informacoes",
      responsavelId: 7,
    })
    expect(db.insercoes[0]!.valores).toMatchObject({
      tipoEvento: "devolucao_precisa_info",
      mensagem: "Falta o código do cliente.",
    })
    expect(eventos[0]!.payload).toEqual({
      previousStatus: "delegada",
      status: "precisa_informacoes",
    })
  })

  it("devolução sabor concluída preenche concluidaEm", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const db = dbFake({ tarefas: [tarefa], colaboradores: COLABORADORES })
    const svc = service(db)

    const resultado = await svc.devolver(PROJETO, ctx("admin", 7), 42, {
      sabor: "concluida",
      mensagem: "Entregue.",
    })
    expect(resultado.status).toBe("concluida")
    expect(resultado.concluidaEm).toEqual(expect.any(String))
    expect(resultado.evento.tipoEvento).toBe("devolucao_concluida")
    expect(db.updates[0]!.set).toMatchObject({ status: "concluida" })
    expect(db.updates[0]!.set.concluidaEm).toEqual(expect.any(String))
  })

  it("devolução sem mensagem → 409 claro (pré-condição da máquina)", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const db = dbFake({ tarefas: [tarefa], colaboradores: COLABORADORES })
    const svc = service(db)
    await expect(
      svc.devolver(PROJETO, ctx("admin", 7), 42, {
        sabor: "aguardando_terceiro",
        mensagem: "   ",
      }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      svc.devolver(PROJETO, ctx("admin", 7), 42, {
        sabor: "aguardando_terceiro",
        mensagem: "   ",
      }),
    ).rejects.toThrow(/mensagem não vazia/)
    expect(db.updates).toHaveLength(0)
  })

  it("concluir (atalho) a partir de aberta → 409 (não é aresta da máquina)", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)
    await expect(svc.concluir(PROJETO, ctx("admin", 7), 42)).rejects.toBeInstanceOf(
      ConflictException,
    )
    await expect(svc.concluir(PROJETO, ctx("admin", 7), 42)).rejects.toThrow(
      /estado 'aberta'/,
    )
    expect(db.updates).toHaveLength(0)
    expect(db.insercoes).toHaveLength(0)
  })

  it("concluir a partir de delegada preenche concluidaEm e grava devolucao_concluida", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const db = dbFake({ tarefas: [tarefa], colaboradores: COLABORADORES })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)
    const eventos = rt.eventos

    const resultado = await svc.concluir(PROJETO, ctx("admin", 7), 42)
    expect(resultado.status).toBe("concluida")
    expect(resultado.concluidaEm).toEqual(expect.any(String))
    expect(resultado.evento.tipoEvento).toBe("devolucao_concluida")
    expect(eventos[0]!.type).toBe("task.status.changed")
    expect(eventos[0]!.payload).toEqual({
      previousStatus: "delegada",
      status: "concluida",
    })
  })
})

// ============================================================================
// Notificações do sino na transição (macro #5, subtarefa 2)
// ============================================================================

describe("FluxoTarefasGlobalService — notificações de delegação/devolução", () => {
  // Mesma org, com usuário global vinculado (sino) — e um sem vínculo.
  const COLAB_NOTIFICADAS: Array<Record<string, unknown>> = [
    { id: 5, organizacaoId: 10, nome: "Criador Silva", ativo: true, usuarioId: 55 },
    { id: 7, organizacaoId: 10, nome: "Responsável Souza", ativo: true, usuarioId: 70 },
    { id: 21, organizacaoId: 10, nome: "Alvo Notificado", ativo: true, usuarioId: 77 },
    { id: 23, organizacaoId: 10, nome: "Sem Usuário", ativo: true },
  ]

  it("delegar: INSERT notificacao (delegacao → alvo) na MESMA transição + push notification.created pós-commit", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLAB_NOTIFICADAS })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)

    const resultado = await svc.delegar(PROJETO, ctx("admin"), 42, { responsavelId: 21 })

    const notif = db.insercoes.find((i) => i.tabela === "notificacoes")
    expect(notif).toBeDefined()
    expect(notif!.valores).toMatchObject({
      organizacaoId: 10,
      usuarioId: 77,
      tipo: "delegacao",
      tarefaId: 42,
      lida: false,
    })
    expect(notif!.valores.titulo).toContain("Tarefa teste")
    // AFTER o histórico — mesma transação, mesma chamada db.transaction.
    expect(db.insercoes.findIndex((i) => i.tabela === "notificacoes")).toBeGreaterThan(
      db.insercoes.findIndex((i) => i.tabela === "historico_tarefas"),
    )
    expect(db.transacoes).toEqual([{ inicio: true, fim: true, erro: null }])

    expect(resultado.notificacao).toMatchObject({
      usuarioId: 77,
      tipo: "delegacao",
      lida: false,
    })
    // Push só pós-commit, na janela dos eventos: status primeiro, sino depois.
    const tipos = rt.eventos.map((e) => e.type)
    expect(tipos).toEqual(["task.status.changed", "notification.created"])
    const criado = rt.eventos[1]!
    expect(criado.canal).toBe("notifications")
    expect(criado.projectId).toBe(13)
    expect(criado.usuarioId).toBe(77)
    expect(
      (criado.payload as { notification: Record<string, unknown> }).notification,
    ).toMatchObject({ tipo: "delegacao", usuarioId: 77, tarefaId: 42 })
  })

  it("devolver: destinatário = autor da última delegação que entregou a tarefa a quem devolve", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const historico = [
      {
        id: 1,
        tarefaId: 42,
        tipoEvento: "delegacao",
        deColaboradorId: 5,
        paraColaboradorId: 7,
        mensagem: null,
        criadoEm: new Date("2026-11-24T10:00:00.000Z"),
      },
      // Ruído: evento que NÃO entregou a 7 (não deve ser escolhido).
      {
        id: 2,
        tarefaId: 42,
        tipoEvento: "reatribuicao",
        deColaboradorId: 5,
        paraColaboradorId: 21,
        mensagem: null,
        criadoEm: new Date("2026-11-24T11:00:00.000Z"),
      },
    ]
    const db = dbFake({
      tarefas: [tarefa],
      colaboradores: COLAB_NOTIFICADAS,
      historico_tarefas: historico,
    })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)

    const resultado = await svc.devolver(PROJETO, ctx("operador", 7), 42, {
      sabor: "precisa_informacoes",
      mensagem: "Falta o CPF do cliente.",
    })

    expect(resultado.notificacao).toMatchObject({ usuarioId: 55, tipo: "devolucao" })
    const notif = db.insercoes.find((i) => i.tabela === "notificacoes")
    expect(notif!.valores).toMatchObject({ usuarioId: 55, tipo: "devolucao", tarefaId: 42 })
    expect(notif!.valores.titulo).toContain("devolvida")
    expect(notif!.valores.corpo).toContain("Falta o CPF do cliente.")
    expect(rt.eventos.some((e) => e.type === "notification.created")).toBe(true)
  })

  it("devolver sem histórico de delegação: fallback = criador da tarefa", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const db = dbFake({
      tarefas: [tarefa],
      colaboradores: COLAB_NOTIFICADAS,
      historico_tarefas: [],
    })
    const svc = service(db, realtimeFake().realtime)

    const resultado = await svc.devolver(PROJETO, ctx("operador", 7), 42, {
      sabor: "concluida",
      mensagem: "Pronto.",
    })
    expect(resultado.notificacao).toMatchObject({ usuarioId: 55, tipo: "devolucao" })
  })

  it("destinatário sem usuario_id (sem usuário global): pula sino, transição intata", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLAB_NOTIFICADAS })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)

    const resultado = await svc.delegar(PROJETO, ctx("admin"), 42, { responsavelId: 23 })
    expect(resultado.status).toBe("delegada")
    expect(resultado.notificacao).toBeNull()
    expect(db.insercoes.some((i) => i.tabela === "notificacoes")).toBe(false)
    expect(rt.eventos.map((e) => e.type)).toEqual(["task.status.changed"])
  })

  it("cancelar não gera notificação (fora do critério)", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLAB_NOTIFICADAS })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)

    const resultado = await svc.cancelar(PROJETO, ctx("operador", 5), 42, {
      motivo: "Duplicada.",
    })
    expect(resultado.notificacao).toBeNull()
    expect(db.insercoes.some((i) => i.tabela === "notificacoes")).toBe(false)
    expect(rt.eventos.some((e) => e.type === "notification.created")).toBe(false)
  })

  it("devolução cujo delegador é o próprio autor: sem autoflagelo de sino", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const historico = [
      {
        id: 1,
        tarefaId: 42,
        tipoEvento: "delegacao",
        deColaboradorId: 7,
        paraColaboradorId: 7,
        mensagem: null,
        criadoEm: new Date("2026-11-24T10:00:00.000Z"),
      },
    ]
    const db = dbFake({
      tarefas: [tarefa],
      colaboradores: COLAB_NOTIFICADAS,
      historico_tarefas: historico,
    })
    const svc = service(db, realtimeFake().realtime)

    const resultado = await svc.devolver(PROJETO, ctx("operador", 7), 42, {
      sabor: "concluida",
      mensagem: "Fechei sozinho.",
    })
    expect(resultado.status).toBe("concluida")
    expect(resultado.notificacao).toBeNull()
    expect(db.insercoes.some((i) => i.tabela === "notificacoes")).toBe(false)
  })
})

// ============================================================================
// Cancelar
// ============================================================================

describe("FluxoTarefasGlobalService — cancelar", () => {
  it("cancelar: criador pode (sem ser responsável/admin), grava mudanca_status e publica evento", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)
    const eventos = rt.eventos

    const resultado = await svc.cancelar(PROJETO, ctx("operador", 5), 42, {
      motivo: "Duplicada.",
    })
    expect(resultado.status).toBe("cancelada")
    expect(resultado.evento.tipoEvento).toBe("mudanca_status")
    expect(db.insercoes[0]!.valores).toMatchObject({
      tipoEvento: "mudanca_status",
      mensagem: expect.stringContaining("aberta → cancelada"),
    })
    expect(eventos[0]!.payload).toEqual({ previousStatus: "aberta", status: "cancelada" })
  })

  it("403: colaborador sem relação (nem responsável, nem criador, nem admin/gerente)", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)
    await expect(svc.cancelar(PROJETO, ctx("operador", 9), 42, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    await expect(
      svc.delegar(PROJETO, ctx("operador", 9), 42, { responsavelId: 5 }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(
      svc.devolver(PROJETO, ctx("operador", 9), 42, { sabor: "concluida", mensagem: "x" }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(db.updates).toHaveLength(0)
    expect(db.insercoes).toHaveLength(0)
  })
})

// ============================================================================
// Escopo row-level (404) e estados terminais
// ============================================================================

describe("FluxoTarefasGlobalService — escopo e estados terminais", () => {
  it("404: tarefa de outra organização (fora do row-level da sessão)", async () => {
    const tarefaOutraOrg = { ...TAREFA, organizacaoId: 99 }
    const db = dbFake({ tarefas: [tarefaOutraOrg], colaboradores: COLABORADORES })
    const svc = service(db)
    await expect(
      svc.delegar(PROJETO, ctx("admin"), 42, { responsavelId: 9 }),
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(svc.historico(PROJETO, ctx("admin"), 42)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    await expect(
      svc.criarMensagem(PROJETO, ctx("admin"), 42, { texto: "oi" }),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(db.updates).toHaveLength(0)
    expect(db.insercoes).toHaveLength(0)
  })

  it("409 claro: ação em estado terminal (concluida/cancelada)", async () => {
    const tarefaConcluida = { ...TAREFA, status: "concluida" as const }
    const db = dbFake({ tarefas: [tarefaConcluida], colaboradores: COLABORADORES })
    const svc = service(db)
    await expect(
      svc.delegar(PROJETO, ctx("admin", 7), 42, { responsavelId: 9 }),
    ).rejects.toThrow(/terminal 'concluida'/)

    const tarefaCancelada = { ...TAREFA, status: "cancelada" as const }
    const db2 = dbFake({ tarefas: [tarefaCancelada], colaboradores: COLABORADORES })
    const svc2 = service(db2)
    await expect(svc2.cancelar(PROJETO, ctx("admin", 7), 42, {})).rejects.toThrow(
      /terminal 'cancelada'/,
    )
  })
})

// ============================================================================
// Histórico (append-only, somente leitura)
// ============================================================================

describe("FluxoTarefasGlobalService — histórico", () => {
  it("GET cronológico (criadoEm, id) com nomes de de/para", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const historico = [
      {
        id: 2,
        tarefaId: 42,
        tipoEvento: "reatribuicao",
        deColaboradorId: 9,
        paraColaboradorId: 7,
        mensagem: null,
        criadoEm: new Date("2026-11-24T12:00:00.000Z"),
      },
      {
        id: 1,
        tarefaId: 42,
        tipoEvento: "delegacao",
        deColaboradorId: 7,
        paraColaboradorId: 9,
        mensagem: "Primeira delegação.",
        criadoEm: new Date("2026-11-24T10:00:00.000Z"),
      },
    ]
    const db = dbFake({ tarefas: [tarefa], colaboradores: COLABORADORES, historico_tarefas: historico })
    const svc = service(db)

    const itens = await svc.historico(PROJETO, ctx("operador", 5), 42)
    // O fake devolve as linhas já ordenadas pela ORDER BY do SQL real —
    // aqui as fixtures já estão fora de ordem propositalmente:
    expect(itens.map((i) => i.id)).toEqual([1, 2])
    expect(itens[0]).toMatchObject({
      tipoEvento: "delegacao",
      deColaboradorNome: "Responsável Souza",
      paraColaboradorNome: "Alvo Lima",
      mensagem: "Primeira delegação.",
      criadoEm: "2026-11-24T10:00:00.000Z",
    })
    expect(itens[1]).toMatchObject({
      tipoEvento: "reatribuicao",
      deColaboradorNome: "Alvo Lima",
      paraColaboradorNome: "Responsável Souza",
    })
    // Somente leitura: nenhuma escrita nesta operação.
    expect(db.updates).toHaveLength(0)
    expect(db.insercoes).toHaveLength(0)
  })
})

// ============================================================================
// Chat (mensagens_tarefa)
// ============================================================================

describe("FluxoTarefasGlobalService — chat", () => {
  it("POST grava autorId da SESSÃO (nunca do body) e publica chat.message.created", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const db = dbFake({ tarefas: [tarefa], colaboradores: COLABORADORES })
    const rt = realtimeFake()
    const svc = service(db, rt.realtime)
    const eventos = rt.eventos

    const mensagem = await svc.criarMensagem(PROJETO, ctx("operador", 5), 42, {
      texto: "Ando bem?",
    })
    expect(mensagem.autorId).toBe(5)
    expect(mensagem.autorNome).toBe("Criador Silva")
    expect(mensagem.texto).toBe("Ando bem?")
    expect(mensagem.criadoEm).toEqual(expect.any(String))

    expect(db.insercoes).toHaveLength(1)
    expect(db.insercoes[0]!.tabela).toBe("mensagens_tarefa")
    expect(db.insercoes[0]!.valores).toMatchObject({
      tarefaId: 42,
      autorId: 5,
      texto: "Ando bem?",
    })

    const evento = eventos.find((e) => e.type === "chat.message.created")
    expect(evento).toBeDefined()
    expect(evento?.projectId).toBe(13)
    expect(evento?.taskId).toBe(42)
    expect(evento?.payload).toMatchObject({
      message: { autorId: 5, texto: "Ando bem?" },
    })
    expect(evento?.eventId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("GET retorna autor (nome) e data em ordem cronológica", async () => {
    const tarefa = { ...TAREFA, status: "delegada" as const }
    const mensagens = [
      {
        id: 1,
        tarefaId: 42,
        autorId: 5,
        texto: "Onde está?",
        criadoEm: new Date("2026-11-24T10:00:00.000Z"),
      },
      {
        id: 2,
        tarefaId: 42,
        autorId: 9,
        texto: "Respondendo.",
        criadoEm: new Date("2026-11-24T11:00:00.000Z"),
      },
    ]
    const db = dbFake({ tarefas: [tarefa], colaboradores: COLABORADORES, mensagens_tarefa: mensagens })
    const svc = service(db)

    const itens = await svc.listarMensagens(PROJETO, ctx("operador", 7), 42)
    expect(itens.map((m) => m.id)).toEqual([1, 2])
    expect(itens[0]).toMatchObject({
      autorId: 5,
      autorNome: "Criador Silva",
      texto: "Onde está?",
      criadoEm: "2026-11-24T10:00:00.000Z",
    })
    expect(itens[1]!.autorNome).toBe("Alvo Lima")
  })
})

// ============================================================================
// Dashboard pessoal — GET .../tarefas/minhas (macro #7, subtarefa 1)
// ============================================================================

describe("FluxoTarefasGlobalService — minhasTarefas (dashboard pessoal)", () => {
  const AREAS = [
    { id: 1, organizacaoId: 10, nome: "Operações" },
    { id: 2, organizacaoId: 10, nome: "Suporte" },
  ]

  it("retorna só tarefas do responsável da sessão, da org da sessão, em estado não terminal, com nome da área", async () => {
    const tarefas = [
      { id: 1, organizacaoId: 10, titulo: "Minha", responsavelId: 7, status: "aberta", areaId: 1, prioridade: "media", prazo: "2026-12-01T12:00:00.000Z" },
      // Outro responsável → nunca aparece.
      { id: 2, organizacaoId: 10, titulo: "De outro", responsavelId: 9, status: "aberta", areaId: 1, prioridade: "media", prazo: null },
      // Outra organização → nunca aparece (isolamento row-level).
      { id: 3, organizacaoId: 99, titulo: "Outra org", responsavelId: 7, status: "aberta", areaId: null, prioridade: "media", prazo: null },
      // Estados terminais → saem da lista.
      { id: 4, organizacaoId: 10, titulo: "Concluída", responsavelId: 7, status: "concluida", areaId: 1, prioridade: "urgente", prazo: "2026-12-01T12:00:00.000Z" },
      { id: 5, organizacaoId: 10, titulo: "Cancelada", responsavelId: 7, status: "cancelada", areaId: null, prioridade: "alta", prazo: null },
      // Não terminais → entram.
      { id: 6, organizacaoId: 10, titulo: "Delegada", responsavelId: 7, status: "delegada", areaId: 2, prioridade: "baixa", prazo: "2026-12-02T12:00:00.000Z" },
      { id: 7, organizacaoId: 10, titulo: "Precisa info", responsavelId: 7, status: "precisa_informacoes", areaId: null, prioridade: "alta", prazo: "2026-12-03T12:00:00.000Z" },
      { id: 8, organizacaoId: 10, titulo: "Aguardando 3º", responsavelId: 7, status: "aguardando_terceiro", areaId: 2, prioridade: "urgente", prazo: null },
    ]
    const db = dbFake({ tarefas, colaboradores: COLABORADORES, areas: AREAS })
    const svc = service(db)

    const { itens } = await svc.minhasTarefas(PROJETO, ctx("operador"))
    expect(itens.map((i) => i.id)).toEqual([1, 6, 7, 8])
    // Área: nome pelo leftJoin; areaId nulo → areaNome null.
    expect(itens[0]).toMatchObject({ id: 1, titulo: "Minha", areaId: 1, areaNome: "Operações", status: "aberta" })
    expect(itens[1]!.areaNome).toBe("Suporte")
    expect(itens[2]!.areaId).toBeNull()
    expect(itens[2]!.areaNome).toBeNull()
    // Prazo vem como string (datetime mode: "string").
    expect(itens[0]!.prazo).toBe("2026-12-01T12:00:00.000Z")
  })

  it("ordena por prazo ASC com NULLs por último, desempate por prioridade (urgente primeiro) e id", async () => {
    const base = { organizacaoId: 10, responsavelId: 7, status: "aberta", areaId: null }
    const tarefas = [
      { ...base, id: 1, titulo: "baixa sem prazo", prioridade: "baixa", prazo: null },
      { ...base, id: 2, titulo: "alta sem prazo", prioridade: "alta", prazo: null },
      { ...base, id: 3, titulo: "urgente sem prazo", prioridade: "urgente", prazo: null },
      { ...base, id: 4, titulo: "urgente 05", prioridade: "urgente", prazo: "2026-12-05T12:00:00.000Z" },
      { ...base, id: 5, titulo: "media 05", prioridade: "media", prazo: "2026-12-05T12:00:00.000Z" },
      { ...base, id: 6, titulo: "baixa 05", prioridade: "baixa", prazo: "2026-12-05T12:00:00.000Z" },
      { ...base, id: 7, titulo: "alta 04", prioridade: "alta", prazo: "2026-12-04T12:00:00.000Z" },
    ]
    const db = dbFake({ tarefas, colaboradores: COLABORADORES, areas: AREAS })
    const svc = service(db)

    const { itens } = await svc.minhasTarefas(PROJETO, ctx("operador"))
    expect(itens.map((i) => i.id)).toEqual([7, 4, 5, 6, 3, 2, 1])
  })

  it("lista vazia quando o colaborador não tem tarefas ativas", async () => {
    const tarefas = [
      { id: 1, organizacaoId: 10, titulo: "De outro", responsavelId: 9, status: "aberta", areaId: null, prioridade: "media", prazo: null },
    ]
    const db = dbFake({ tarefas, colaboradores: COLABORADORES, areas: AREAS })
    const svc = service(db)
    const { itens } = await svc.minhasTarefas(PROJETO, ctx("operador"))
    expect(itens).toEqual([])
  })
})

// ============================================================================
// Contexto da request — 403 sem colaborador ativo (macro #7, subtarefa 1)
// ============================================================================

describe("FluxoTarefasGlobalService — contextoDaRequest (403)", () => {
  function svcSemDb() {
    const db = dbFake({ tarefas: [], colaboradores: COLABORADORES })
    return service(db)
  }

  it("403: sessão master da plataforma não opera em dados de negócio", async () => {
    const svc = svcSemDb()
    const req = {
      escopoOrganizacao: { tipo: "master", usuarioId: 1 } as never,
    }
    await expect(
      Promise.resolve().then(() => svc.contextoDaRequest(req as never)),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("403: escopo não resolvido (guard não executou)", async () => {
    const svc = svcSemDb()
    await expect(
      Promise.resolve().then(() => svc.contextoDaRequest({} as never)),
    ).rejects.toThrow(/EscopoOrganizacaoGuard não executou/)
  })
})
