// @vitest-environment node
/**
 * Testes unitários do NotificacoesService (gestao-de-tarefas-global —
 * macro #5, subtarefa 2): criação atômica na transação do chamador, push
 * pós-commit e queries do sino sempre own-only.
 *
 * Estratégia: db fake encadeável (padrão do spec de fluxo) — condições
 * renderizadas pelo dialect Drizzle real e avaliadas contra fixtures;
 * `update` MUTA as linhas (contagem antes/depois fiel ao SQL efetivo).
 *
 * Cobre:
 * - inserirEmTransacao: insert na tx informada, sem publicar;
 * - publicarCriada / notifications.unread.changed: payloads e tolerância a
 *   falha de push (GET do sino é a fonte de verdade);
 * - listar: filtro apenasNaoLidas, ordem desc, limite (default 50, clamp
 *   100) e contagem de naoLidas sempre por usuarioId da sessão;
 * - marcarLida: só a do próprio usuário (id alheio = 404, sem vazar
 *   existência), idempotente, push com a contagem restante;
 * - marcarTodasLidas: quantas marcadas + restante 0 + push.
 */
import { describe, expect, it, vi } from "vitest"
import { NotFoundException } from "@nestjs/common"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { notificacoes } from "../../../../../../projects/gestao-de-tarefas-global/schema"
import type { ProjectDbFactory } from "../../crud/project-db.factory"
import { NotificacoesService } from "../notificacoes.service"

const dialect = new MySqlDialect()

/** Coluna snake_case (SQL) → chave camelCase da fixture (tabela notificacoes). */
const CHAVES = new Map<string, string>()
for (const [prop, coluna] of Object.entries(
  notificacoes as unknown as Record<string, { name?: string }>,
)) {
  if (coluna?.name) CHAVES.set(coluna.name, prop)
}

type Linha = Record<string, unknown>

interface FakeApi {
  db: unknown
  limites: number[]
  updates: Array<{ set: Record<string, unknown>; condicoes: Array<{ campo: string; valor: unknown }> }>
  linhas: () => Linha[]
}

function renderizarCond(cond: unknown): { sql: string; params: unknown[] } {
  const r = dialect.sqlToQuery(cond as never)
  const paramsIn: unknown[] = []
  const iter = (r.params as unknown[])[Symbol.iterator]()
  // Colunas chegam como params do dialect — inlinha como `col` para que os
  // params finais sejam apenas os VALORES na ordem dos placeholders `?`.
  const sql = r.sql.replace(/\?/g, () => {
    const { value, done } = iter.next()
    const col = value as { name?: unknown; tableName?: unknown } | null
    if (
      !done &&
      col &&
      typeof col === "object" &&
      typeof col.name === "string" &&
      typeof col.tableName === "string"
    ) {
      return `\`${col.name}\``
    }
    paramsIn.push(value)
    return "?"
  })
  return { sql, params: paramsIn }
}

/** `col = ?` / `col IN (?,..)` do SQL renderizado (mesmo truque do spec fluxo). */
function extrairCondicoes(
  sql: string,
  params: unknown[],
): Array<{ campo: string; valores: unknown[] }> {
  const condicoes: Array<{ campo: string; valores: unknown[] }> = []
  const regioesIn: Array<{ inicio: number; fim: number }> = []
  const reIn = /`(\w+)` IN \(([^)]*)\)/gi
  let mIn: RegExpExecArray | null
  while ((mIn = reIn.exec(sql)) !== null) {
    const inicio = sql.slice(0, mIn.index).split("?").length - 1
    const marcadores = (mIn[2]!.match(/\?/g) ?? []).length
    condicoes.push({ campo: mIn[1]!, valores: params.slice(inicio, inicio + marcadores) })
    regioesIn.push({ inicio, fim: inicio + marcadores })
  }
  const reEq = /`(\w+)` = \?/g
  let mEq: RegExpExecArray | null
  while ((mEq = reEq.exec(sql)) !== null) {
    const inicio = sql.slice(0, mEq.index).split("?").length - 1
    if (regioesIn.some((r) => inicio >= r.inicio && inicio < r.fim)) continue
    condicoes.push({ campo: mEq[1]!, valores: [params[inicio]] })
  }
  return condicoes
}

function matches(linha: Linha, sql: string, params: unknown[]): boolean {
  return extrairCondicoes(sql, params).every((c) => {
    const chave = CHAVES.get(c.campo)
    if (!chave) throw new Error(`coluna desconhecida no fake: notificacoes.${c.campo}`)
    return c.valores.some((v) => Number(v) === Number(linha[chave]))
  })
}

function fakeDb(fixture: Linha[]): FakeApi {
  const linhas = [...fixture]
  const limites: number[] = []
  const updates: FakeApi["updates"] = []

  const ordena = (arr: Linha[], ords: unknown[]): Linha[] => {
    const criterios = ords.map((o) => {
      const { sql } = renderizarCond(o)
      const backticks = sql.match(/`(\w+)`/g) ?? []
      const campo = (backticks[backticks.length - 1] ?? "").replace(/`/g, "")
      return { chave: CHAVES.get(campo) ?? campo, dir: /\bdesc\b/i.test(sql) ? -1 : 1 }
    })
    return [...arr].sort((a, b) => {
      for (const c of criterios) {
        const va = a[c.chave]
        const vb = b[c.chave]
        const na = va instanceof Date ? va.getTime() : Number(va)
        const nb = vb instanceof Date ? vb.getTime() : Number(vb)
        if (na !== nb) return (na > nb ? 1 : -1) * c.dir
      }
      return 0
    })
  }

  /** Builder awaitável do Drizzle: .limit() / .orderBy() / await direto. */
  interface WrapBuilder {
    limit: (n: number) => Promise<Linha[]>
    orderBy: (...ords: unknown[]) => WrapBuilder
    then: (res: (v: Linha[]) => unknown, rej?: (e: unknown) => void) => void
  }
  const wrap = (arr: Linha[]): WrapBuilder => ({
    limit: async (n: number) => {
      limites.push(n)
      return arr.slice(0, n)
    },
    orderBy: (...ords: unknown[]) => wrap(ordena(arr, ords)),
    then: (res, rej) => {
      try {
        res(arr)
      } catch (e) {
        rej?.(e)
      }
    },
  })

  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          const { sql, params } = renderizarCond(cond)
          return wrap(linhas.filter((l) => matches(l, sql, params)))
        },
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const { sql, params } = renderizarCond(cond)
          updates.push({
            set,
            condicoes: extrairCondicoes(sql, params).map((c) => ({
              campo: CHAVES.get(c.campo) ?? c.campo,
              valor: c.valores[0],
            })),
          })
          for (const linha of linhas) {
            if (matches(linha, sql, params)) Object.assign(linha, set)
          }
          return Promise.resolve([])
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        const id = 900 + linhas.length
        linhas.push({ id, ...v })
        return Promise.resolve([{ insertId: id }])
      },
    }),
  }

  return { db: db as never, limites, updates, linhas: () => linhas }
}

const PROJETO = {
  id: 13,
  nome: "Gestão",
  slug: "gestao-de-tarefas-global",
  perfil: "admin",
} as const

function realtimeFake() {
  const eventos: Array<Record<string, unknown>> = []
  return {
    realtime: {
      publicarNotificacoes: vi.fn((input: Record<string, unknown>) => {
        eventos.push(input)
      }),
    } as never,
    eventos,
  }
}

function serviceDe(fake: FakeApi, realtime?: never) {
  const factory = { obter: vi.fn(async () => fake.db) } as unknown as ProjectDbFactory
  return new NotificacoesService(factory, (realtime ?? realtimeFake().realtime) as never)
}

function linhasFixture(): Linha[] {
  return [
    { id: 1, organizacaoId: 10, usuarioId: 77, titulo: "Delegada A", corpo: null, tipo: "delegacao", tarefaId: 42, lida: false, criadoEm: new Date("2026-11-24T10:00:00.000Z") },
    { id: 2, organizacaoId: 10, usuarioId: 77, titulo: "Lida B", corpo: "x", tipo: "lembrete", tarefaId: 43, lida: true, criadoEm: new Date("2026-11-24T11:00:00.000Z") },
    { id: 3, organizacaoId: 10, usuarioId: 77, titulo: "Devolvida C", corpo: null, tipo: "devolucao", tarefaId: 44, lida: false, criadoEm: new Date("2026-11-24T12:00:00.000Z") },
    { id: 4, organizacaoId: 10, usuarioId: 88, titulo: "Do vizinho", corpo: null, tipo: "delegacao", tarefaId: 45, lida: false, criadoEm: new Date("2026-11-24T13:00:00.000Z") },
  ]
}

describe("NotificacoesService — sino own-only", () => {
  it("listar: só do usuário da sessão, mais recentes 1º, contagem de não lidas", async () => {
    const fake = fakeDb(linhasFixture())
    const res = await serviceDe(fake).listar(PROJETO as never, 77)
    expect(res.itens.map((i) => i.id)).toEqual([3, 2, 1])
    expect(res.naoLidas).toBe(2)
    expect(fake.limites[0]).toBe(50) // LIMITE_PADRAO
    expect(res.itens.some((i) => i.id === 4)).toBe(false) // nunca vaza outro usuário
  })

  it("listar apenasNaoLidas + limite custom clampado em 100", async () => {
    const fake = fakeDb(linhasFixture())
    const res = await serviceDe(fake).listar(PROJETO as never, 77, {
      apenasNaoLidas: true,
      limite: 500,
    })
    expect(res.itens.map((i) => i.id)).toEqual([3, 1])
    expect(fake.limites[0]).toBe(100) // clamp LIMITE_MAXIMO
  })

  it("contarNaoLidas", async () => {
    const fake = fakeDb(linhasFixture())
    const res = await serviceDe(fake).contarNaoLidas(PROJETO as never, 77)
    expect(res).toEqual({ contagem: 2 })
  })

  it("marcarLida: atualiza com id+usuarioId, publica unread.changed com restante", async () => {
    const fake = fakeDb(linhasFixture())
    const rt = realtimeFake()
    const item = await serviceDe(fake, rt.realtime).marcarLida(PROJETO as never, 77, 1)
    expect(item).toMatchObject({ id: 1, lida: true, titulo: "Delegada A" })
    expect(fake.updates).toHaveLength(1)
    expect(fake.updates[0]!.set).toEqual({ lida: true })
    expect(fake.updates[0]!.condicoes).toEqual(
      expect.arrayContaining([
        { campo: "id", valor: 1 },
        { campo: "usuarioId", valor: 77 },
      ]),
    )
    const push = rt.eventos.find((e) => e.type === "notifications.unread.changed")
    expect(push).toBeDefined()
    expect(push!.usuarioId).toBe(77)
    expect((push!.payload as { unreadCount: number }).unreadCount).toBe(1)
  })

  it("marcarLida de outro usuário = 404 (sem vazar existência)", async () => {
    const fake = fakeDb(linhasFixture())
    await expect(
      serviceDe(fake).marcarLida(PROJETO as never, 77, 4),
    ).rejects.toBeInstanceOf(NotFoundException)
    expect(fake.updates).toHaveLength(0)
  })

  it("marcarLida id inexistente = 404", async () => {
    const fake = fakeDb(linhasFixture())
    await expect(
      serviceDe(fake).marcarLida(PROJETO as never, 77, 999),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("marcarTodasLidas: zera não lidas do usuário (só dele) e publica 0", async () => {
    const fake = fakeDb(linhasFixture())
    const rt = realtimeFake()
    const res = await serviceDe(fake, rt.realtime).marcarTodasLidas(PROJETO as never, 77)
    expect(res).toEqual({ atualizadas: 2, naoLidas: 0 })
    expect(fake.linhas().find((l) => l.id === 4)!.lida).toBe(false)
    const push = rt.eventos.find((e) => e.type === "notifications.unread.changed")
    expect((push!.payload as { unreadCount: number }).unreadCount).toBe(0)
  })

  it("inserirEmTransacao: insere na tx do chamador e NÃO publica", async () => {
    const fake = fakeDb([])
    const rt = realtimeFake()
    const criada = await serviceDe(fake, rt.realtime).inserirEmTransacao(
      fake.db as never,
      {
        organizacaoId: 10,
        usuarioId: 77,
        titulo: "Olá",
        corpo: "Mundo",
        tipo: "sistema",
        tarefaId: null,
        criadoEm: new Date("2026-11-25T00:00:00.000Z"),
      },
    )
    expect(criada).toMatchObject({ id: 900, usuarioId: 77, tipo: "sistema", lida: false })
    expect(criada.criadoEm).toBe("2026-11-25T00:00:00.000Z")
    expect(rt.eventos).toHaveLength(0)
  })

  it("publicarCriada: falha de push é engolida (GET do sino é a verdade)", () => {
    const fake = fakeDb([])
    const realtime = {
      publicarNotificacoes: vi.fn(() => {
        throw new Error("socket fora")
      }),
    } as never
    expect(() =>
      serviceDe(fake, realtime).publicarCriada(13, {
        id: 1,
        organizacaoId: 10,
        usuarioId: 77,
        titulo: "t",
        corpo: null,
        tipo: "delegacao",
        tarefaId: null,
        lida: false,
        criadoEm: "2026-11-25T00:00:00.000Z",
      }),
    ).not.toThrow()
  })
})
