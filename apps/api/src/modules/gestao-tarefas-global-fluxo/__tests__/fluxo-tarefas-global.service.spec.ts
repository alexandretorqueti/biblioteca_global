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
 *   envio (eventId uuid, projectId do token, taskId).
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
        ? cond.valores.some((v) => Number(v) === Number(valor))
        : Number(cond.valores[0]) === Number(valor)
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

  const whereChain = (tabela: Tabela, cond: unknown) => {
    const { sql: condSql, params: condParams } = renderizar(cond as never)
    const linhas = avaliar(tabela, fixture, condSql, condParams)
    return {
      limit: async () => linhas,
      // Fiel ao Drizzle: `select().from().where()` SEM limit/orderBy é um
      // builder awaitável — resolve direto para as linhas (nomesColaboradores
      // usa exatamente esse encadeamento).
      then: (
        res: (v: Array<Record<string, unknown>>) => unknown,
        rej?: (e: unknown) => void,
      ) => {
        try {
          res(linhas)
        } catch (e) {
          rej?.(e)
        }
      },
      // ORDER BY fiel: extrai (coluna, direção) de cada expressão `col asc|desc`
      // e ordena as linhas — os GETs de histórico/chat dependem da ordem real.
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
          return { campo, dir, chave }
        })
        const ordenadas = [...linhas].sort((a, b) => {
          for (const c of criterios) {
            const va = a[c.chave]
            const vb = b[c.chave]
            const na = va instanceof Date ? va.getTime() : Number(va)
            const nb = vb instanceof Date ? vb.getTime() : Number(vb)
            if (na !== nb) return (na > nb ? 1 : -1) * c.dir
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
    select: () => ({
      from: (tabela: unknown) => ({
        where: (cond: unknown) => {
          const chain = whereChain(nomeDaTabela(tabela), cond)
          return {
            limit: chain.limit,
            orderBy: chain.orderBy,
            then: chain.then,
          }
        },
        // select(...).from(tabela).orderBy(...) sem where (não usado aqui, mas
        // mantém o encadeamento completo do Drizzle).
        orderBy: (...ords: unknown[]) => whereChain(nomeDaTabela(tabela), undefined as never).orderBy(...ords),
      }),
    }),
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
  return { realtime: { publicar } as never, eventos }
}

function service(db: DbFakeApi, realtime?: { publicar: (e: unknown) => unknown }) {
  const factory = { obter: vi.fn(async () => db.db) } as unknown as ProjectDbFactory
  return new FluxoTarefasGlobalService(factory, (realtime ?? realtimeFake().realtime) as never)
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
