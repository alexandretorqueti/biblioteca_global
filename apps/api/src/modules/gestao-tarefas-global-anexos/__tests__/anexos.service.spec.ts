// @vitest-environment node
/**
 * Testes unitários do GestaoTarefasGlobalAnexosService (gestao-de-tarefas-global
 * — macro #6, subtarefa 1): upload multipart, armazenamento em disco com
 * chave LÓGICA, listagem e download/preview (REQ-F-013, REQ-D-008).
 *
 * Estratégia: db fake encadeável (padrão do spec do fluxo — as condições
 * `where` são RENDERIZADAS pelo dialect Drizzle real e avaliadas contra as
 * linhas-fixture) + I/O REAL em diretório temporário (os.tmpdir) para o
 * armazenamento em disco.
 *
 * Cobre:
 * - upload ok: grava arquivo no ANEXOS_DIR sob `org/{org}/tarefa/{tarefa}/{uuid}.{ext}`,
 *   linha em `anexos` + evento 'anexo' em `historico_tarefas` NA MESMA
 *   transação (atômico, padrão fluxo);
 * - limite de tamanho: buffer > ANEXOS_MAX_BYTES → 400 citando o máximo
 *   (nada gravado em disco nem banco);
 * - whitelist de tipo: pdf/png/jpg + textos (txt, .js, MIME text/*) ok;
 *   exe/zip → 400 com mensagem clara;
 * - saneamento: basename contra path traversal + caracteres → `_`
 *   (o upload NUNCA escreve fora do ANEXOS_DIR);
 * - chave lógica: resposta e coluna `chaveArmazenamento` contêm SOMENTE a
 *   chave org/... — nunca o caminho físico (assert de ausência do path);
 * - escopo row-level: tarefa OU anexo de OUTRA organização → 404 (sem
 *   vazar existência) — upload, listagem, download;
 * - download/preview: StreamableFile com Content-Type do mimeType; inline
 *   SOMENTE para image/png, image/jpeg e application/pdf; demais tipos
 *   attachment;
 * - contexto da sessão: sem escopoOrganizacao → 403 (enviadoPorId é SEMPRE
 *   o colaborador da sessão — nunca do body).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  StreamableFile,
} from "@nestjs/common"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { Perfil, ProjetoResumo } from "@biblioteca-global/shared"
import * as schemaGestao from "../../../../../../projects/gestao-de-tarefas-global/schema"
import type { ProjectDbFactory } from "../../crud/project-db.factory"
import {
  GestaoTarefasGlobalAnexosService,
  type ArquivoAnexoMultipart,
  type ContextoSessaoAnexos,
} from "../anexos.service"

// ============================================================================
// Fake de banco (encadeável, fiel ao SQL renderizado — padrão do fluxo)
// ============================================================================

type Tabela =
  | "tarefas"
  | "colaboradores"
  | "historico_tarefas"
  | "anexos"

interface InsertChamada {
  tabela: Tabela
  valores: Record<string, unknown>
}

interface EventoTransacao {
  inicio: boolean
  fim: boolean
  erro: unknown
}

interface DbFakeApi {
  db: unknown
  insercoes: InsertChamada[]
  transacoes: EventoTransacao[]
}

const dialect = new MySqlDialect()

function chaveColunaPorTabela(): Map<Tabela, Map<string, string>> {
  const mapa = new Map<Tabela, Map<string, string>>()
  for (const [, tabela] of Object.entries(
    schemaGestao,
  ) as Array<[string, Record<string, unknown>]>) {
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

function renderizar(
  cond: { toSQL?: () => { sql: string; params: unknown[] } },
): { sql: string; params: unknown[] } {
  if (typeof cond.toSQL === "function") {
    const r = cond.toSQL()
    return { sql: r.sql, params: r.params as unknown[] }
  }
  const r = dialect.sqlToQuery(cond as never)
  return { sql: r.sql, params: r.params as unknown[] }
}

/**
 * Extrai condições simples (`col = ?` / `col IN (?, ...)`) do SQL renderizado.
 * Suficiente para as queries deste service (sem JOINs/subconsultas).
 */
function extrairCondicoes(
  sql: string,
  params: unknown[],
): Array<{ campo: string; operador: "=" | "in"; valores: unknown[] }> {
  const condicoes: Array<{ campo: string; operador: "=" | "in"; valores: unknown[] }> = []
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

/**
 * Igualdade do fake: numérica quando ambos são números finitos; senão
 * STRING (strings como 'anexo' não viram NaN e quebram o match).
 */
function valorIgual(a: unknown, b: unknown): boolean {
  const na = Number(a)
  const nb = Number(b)
  if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
    return na === nb
  }
  return String(a) === String(b)
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
        ? cond.valores.some((v) => valorIgual(v, valor))
        : valorIgual(cond.valores[0], valor)
    }),
  )
}

function dbFake(
  fixture: Record<string, Array<Record<string, unknown>>>,
): DbFakeApi {
  const insercoes: InsertChamada[] = []
  const transacoes: EventoTransacao[] = []
  let proximoId = 10_000

  const whereChain = (tabela: Tabela, cond: unknown) => {
    const { sql: condSql, params: condParams } = renderizar(cond as never)
    const linhas = avaliar(tabela, fixture, condSql, condParams)
    return {
      limit: async () => linhas,
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
      // ORDER BY fiel: extrai (coluna, direção) e ordena — a listagem de
      // anexos depende da ordem real (criadoEm asc, id asc).
      orderBy: (...ords: unknown[]) => {
        const chaves = CHAVES_POR_TABELA.get(tabela) ?? new Map()
        const criterios = ords.map((o) => {
          const { sql: osql } = renderizar(o as never)
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

  return { db: db as never, insercoes, transacoes }
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

const TAREFA: Record<string, unknown> = {
  id: 42,
  organizacaoId: 10,
  titulo: "Tarefa teste",
  responsavelId: 7,
  criadoPorId: 5,
  status: "aberta",
}

/** Tarefa de OUTRA organização (mesmo id — o filtro é por organização). */
const TAREFA_OUTRA_ORG: Record<string, unknown> = {
  id: 42,
  organizacaoId: 99,
  titulo: "Tarefa de outra org",
  responsavelId: 13,
  criadoPorId: 13,
  status: "aberta",
}

const COLABORADORES: Array<Record<string, unknown>> = [
  { id: 5, organizacaoId: 10, nome: "Criador Silva", ativo: true },
  { id: 7, organizacaoId: 10, nome: "Responsável Souza", ativo: true },
  { id: 13, organizacaoId: 99, nome: "Colab Outra Org", ativo: true },
]

const ANEXO_ORG: Record<string, unknown> = {
  id: 77,
  tarefaId: 42,
  organizacaoId: 10,
  nomeArquivo: "relatorio.pdf",
  mimeType: "application/pdf",
  tamanhoBytes: 5,
  chaveArmazenamento: `org/10/tarefa/42/11111111-1111-4111-8111-111111111111.pdf`,
  enviadoPorId: 7,
  criadoEm: new Date("2026-11-25T12:00:00.000Z"),
}

function ctx(perfil: Perfil = "admin", colaboradorId = 7): ContextoSessaoAnexos {
  return { organizacaoId: 10, colaboradorId, perfil }
}

function arquivo(nome: string, conteudo: Buffer, mimetype?: string): ArquivoAnexoMultipart {
  return {
    originalname: nome,
    filename: nome,
    mimetype,
    size: conteudo.length,
    buffer: conteudo,
  }
}

let dirAnexos: string
let dirRaiz: string

beforeEach(async () => {
  dirRaiz = await mkdtemp(join(tmpdir(), "anexos-spec-"))
  dirAnexos = join(dirRaiz, "anexos")
})

afterEach(async () => {
  await rm(dirRaiz, { recursive: true, force: true }).catch(() => undefined)
})

function envFake(maxBytes = 1024 * 1024) {
  return {
    anexosDir: dirAnexos,
    anexosMaxBytes: maxBytes,
  } as never
}

function service(db: DbFakeApi, maxBytes?: number): GestaoTarefasGlobalAnexosService {
  const factory = { obter: vi.fn(async () => db.db) } as unknown as ProjectDbFactory
  return new GestaoTarefasGlobalAnexosService(factory, envFake(maxBytes))
}

/** Caminho físico do arquivo de um anexo (a partir da chave lógica). */
function caminhoFisico(chaveArmazenamento: string): string {
  return join(dirAnexos, ...chaveArmazenamento.split("/"))
}

// ============================================================================
// Contexto da sessão
// ============================================================================

describe("GestaoTarefasGlobalAnexosService — contexto", () => {
  it("403: request sem escopoOrganizacao (guard não executou)", () => {
    const db = dbFake({})
    const svc = service(db)
    expect(() => svc.contextoDaRequest({} as never)).toThrow(ForbiddenException)
    expect(() => svc.contextoDaRequest({} as never)).toThrow(/EscopoOrganizacaoGuard/)
  })
})

// ============================================================================
// Upload (anexar)
// ============================================================================

describe("GestaoTarefasGlobalAnexosService — anexar (upload)", () => {
  it("pdf: grava arquivo no ANEXOS_DIR sob chave lógica + anexos + histórico 'anexo' na mesma transação", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)

    const resultado = await svc.anexar(
      PROJETO,
      ctx(),
      42,
      arquivo("relatorio.pdf", Buffer.from("%PDF-1"), "application/pdf"),
    )

    // Chave LÓGICA por organização/tarefa — sem path físico.
    expect(resultado.chaveArmazenamento).toMatch(
      /^org\/10\/tarefa\/42\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/,
    )
    expect(resultado.nomeArquivo).toBe("relatorio.pdf")
    expect(resultado.mimeType).toBe("application/pdf")
    expect(resultado.tamanhoBytes).toBe(6) // "%PDF-1" = 6 bytes
    expect(resultado.enviadoPorId).toBe(7)
    expect(resultado.enviadoPorNome).toBe("Responsável Souza")

    // Arquivo REAL gravado em ANEXOS_DIR sob a chave lógica.
    await expect(stat(caminhoFisico(resultado.chaveArmazenamento))).resolves.toBeTruthy()

    // anexos + histórico NA MESMA transação (atômico — padrão fluxo).
    const insAnexos = db.insercoes.filter((i) => i.tabela === "anexos")
    expect(insAnexos).toHaveLength(1)
    expect(insAnexos[0]!.valores).toMatchObject({
      tarefaId: 42,
      organizacaoId: 10,
      nomeArquivo: "relatorio.pdf",
      mimeType: "application/pdf",
      tamanhoBytes: 6,
      chaveArmazenamento: resultado.chaveArmazenamento,
      enviadoPorId: 7,
    })
    const hist = db.insercoes.filter((i) => i.tabela === "historico_tarefas")
    expect(hist).toHaveLength(1)
    expect(hist[0]!.valores).toMatchObject({
      tarefaId: 42,
      tipoEvento: "anexo",
      deColaboradorId: 7,
      paraColaboradorId: null,
    })
    expect(String(hist[0]!.valores.mensagem)).toContain("relatorio.pdf")
    expect(db.transacoes).toEqual([{ inicio: true, fim: true, erro: null }])
  })

  it("aceita png, jpg e textos (txt, .js, MIME text/*) sem MIME declarado", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)

    const png = await svc.anexar(PROJETO, ctx(), 42, arquivo("logo.png", Buffer.from("PNG"), "image/png"))
    expect(png.mimeType).toBe("image/png")
    const jpg = await svc.anexar(PROJETO, ctx(), 42, arquivo("foto.jpg", Buffer.from("JPG"), "image/jpeg"))
    expect(jpg.mimeType).toBe("image/jpeg")
    const txt = await svc.anexar(PROJETO, ctx(), 42, arquivo("notas.txt", Buffer.from("olá")))
    expect(txt.mimeType).toBe("text/plain")
    const js = await svc.anexar(PROJETO, ctx(), 42, arquivo("script.js", Buffer.from("console.log(1)"), "text/javascript"))
    expect(js.mimeType).toBe("text/javascript")
    expect(db.insercoes.filter((i) => i.tabela === "anexos")).toHaveLength(4)
  })

  it("400: buffer acima do ANEXOS_MAX_BYTES — mensagem cita o máximo; nada em disco/banco", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db, 64)

    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("grande.pdf", Buffer.alloc(65), "application/pdf")),
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("grande.pdf", Buffer.alloc(65), "application/pdf")),
    ).rejects.toThrow(/excede o limite de 64 bytes/)
    expect(db.insercoes).toHaveLength(0)
    // Nada gravado em disco (o serviço valida antes de escrever).
    await expect(stat(dirAnexos)).rejects.toThrow()
  })

  it("400: tipo fora da whitelist (exe, zip) — mensagem clara; nada gravado", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)

    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("malware.exe", Buffer.from("MZ"), "application/octet-stream")),
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("malware.exe", Buffer.from("MZ"), "application/octet-stream")),
    ).rejects.toThrow(/não permitido/)
    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("arquivo.zip", Buffer.from("PK"), "application/zip")),
    ).rejects.toThrow(/não permitido/)
    // MIME binário inconsistente com a extensão → rejeitado.
    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("foto.png", Buffer.from("X"), "text/html")),
    ).rejects.toThrow(/não permitido/)
    expect(db.insercoes).toHaveLength(0)
    await expect(stat(dirAnexos)).rejects.toThrow()
  })

  it("saneia o nome: basename (sem path traversal) + caracteres → _; nunca escreve fora do ANEXOS_DIR", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)

    const resultado = await svc.anexar(
      PROJETO,
      ctx(),
      42,
      arquivo("../../../../tmp/../../etc/passwd.txt", Buffer.from("root"), "text/plain"),
    )

    expect(resultado.nomeArquivo).toBe("passwd.txt")
    expect(resultado.chaveArmazenamento).toMatch(/^org\/10\/tarefa\/42\/.+\.(txt|json|js|csv|log|md|txt|html|xml|yml|yaml|ini|cfg|conf|sh|sql|toml|properties|mjs|cjs|markdown|tsv|htm)$/i)
    const caminho = caminhoFisico(resultado.chaveArmazenamento)
    await expect(stat(caminho)).resolves.toBeTruthy()
    // O caminho físico permanece DENTRO do ANEXOS_DIR.
    expect(caminho.startsWith(dirAnexos + sep)).toBe(true)

    // Sem extensão conhecida e sem MIME → FORA da whitelist: rejeitado
    // (a sanitização do nome jamais transforma tipo proibido em aceito).
    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("../../segredo", Buffer.from("x"))),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("404: tarefa de OUTRA organização — nada é gravado (não vaza existência)", async () => {
    const db = dbFake({ tarefas: [TAREFA_OUTRA_ORG], colaboradores: COLABORADORES })
    const svc = service(db)

    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("a.pdf", Buffer.from("%PDF"), "application/pdf")),
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("a.pdf", Buffer.from("%PDF"), "application/pdf")),
    ).rejects.toThrow(/não encontrada/)
    expect(db.insercoes).toHaveLength(0)
    await expect(stat(dirAnexos)).rejects.toThrow()
  })

  it("falha no insert remove o arquivo órfão do disco", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    // Transação cujo tx.insert FALHA (o service deve remover o arquivo que
    // chegou a ser gravado antes do rollback).
    const selectFn = (db.db as { select: unknown }).select
    const dbComErro = {
      select: selectFn,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: selectFn,
          insert: () => {
            throw new Error("falha de insert simulada")
          },
        }),
    }
    const factory = { obter: vi.fn(async () => dbComErro) } as unknown as ProjectDbFactory
    const svc = new GestaoTarefasGlobalAnexosService(factory, envFake())

    await expect(
      svc.anexar(PROJETO, ctx(), 42, arquivo("a.pdf", Buffer.from("%PDF"), "application/pdf")),
    ).rejects.toThrow(/falha de insert simulada/)
    expect(db.insercoes).toHaveLength(0)
    // O arquivo que chegou a ser gravado foi removido (nenhum resíduo de
    // arquivo sob o ANEXOS_DIR — diretórios vazios são inofensivos).
    const { readdir } = await import("node:fs/promises")
    const files: string[] = []
    async function walk(dir: string): Promise<void> {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else files.push(p)
      }
    }
    await walk(dirAnexos)
    expect(files).toHaveLength(0)
  })

  it("400: sem arquivo no multipart", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)
    await expect(svc.anexar(PROJETO, ctx(), 42, undefined)).rejects.toBeInstanceOf(BadRequestException)
    await expect(svc.anexar(PROJETO, ctx(), 42, undefined)).rejects.toThrow(/multipart\/form-data/)
  })
})

// ============================================================================
// Listagem
// ============================================================================

describe("GestaoTarefasGlobalAnexosService — listar", () => {
  const FIXTURE_LISTAR = {
    tarefas: [TAREFA],
    colaboradores: COLABORADORES,
    anexos: [
      {
        id: 1,
        tarefaId: 42,
        organizacaoId: 10,
        nomeArquivo: "primeiro.txt",
        mimeType: "text/plain",
        tamanhoBytes: 3,
        chaveArmazenamento: "org/10/tarefa/42/a1.txt",
        enviadoPorId: 5,
        criadoEm: new Date("2026-11-01T10:00:00.000Z"),
      },
      {
        id: 2,
        tarefaId: 42,
        organizacaoId: 10,
        nomeArquivo: "segundo.pdf",
        mimeType: "application/pdf",
        tamanhoBytes: 100,
        chaveArmazenamento: "org/10/tarefa/42/a2.pdf",
        enviadoPorId: 7,
        criadoEm: new Date("2026-11-02T10:00:00.000Z"),
      },
      {
        // Anexo de OUTRA organização na mesma tarefa (impossível pela FK,
        // mas o filtro organizacao_id deve excluir na query).
        id: 3,
        tarefaId: 42,
        organizacaoId: 99,
        nomeArquivo: "estrangeiro.pdf",
        mimeType: "application/pdf",
        tamanhoBytes: 1,
        chaveArmazenamento: "org/99/tarefa/42/x.pdf",
        enviadoPorId: 13,
        criadoEm: new Date("2026-11-03T10:00:00.000Z"),
      },
    ],
  }

  it("lista em ordem cronológica com autor (nome) e data; exclui anexo de outra org", async () => {
    const db = dbFake(FIXTURE_LISTAR)
    const svc = service(db)

    const itens = await svc.listar(PROJETO, ctx(), 42)

    expect(itens.map((i) => i.id)).toEqual([1, 2])
    expect(itens[0]).toMatchObject({
      nomeArquivo: "primeiro.txt",
      mimeType: "text/plain",
      tamanhoBytes: 3,
      enviadoPorId: 5,
      enviadoPorNome: "Criador Silva",
      chaveArmazenamento: "org/10/tarefa/42/a1.txt",
    })
    expect(itens[0]!.criadoEm).toBe("2026-11-01T10:00:00.000Z")
    expect(itens[1]!.enviadoPorNome).toBe("Responsável Souza")
    // A chave LÓGICA não contém path físico do servidor (a barra da chave
    // lógica org/... é relativa ao ANEXOS_DIR — o que não pode aparecer é o
    // caminho absoluto raiz do storage).
    for (const item of itens) {
      expect(item.chaveArmazenamento.startsWith("org/10/tarefa/42/")).toBe(true)
      expect(item.chaveArmazenamento).not.toContain(dirRaiz)
      expect(item.chaveArmazenamento).not.toContain(sep + sep)
    }
  })

  it("404: tarefa de outra organização", async () => {
    const db = dbFake({ ...FIXTURE_LISTAR, tarefas: [TAREFA_OUTRA_ORG] })
    const svc = service(db)
    await expect(svc.listar(PROJETO, ctx(), 42)).rejects.toBeInstanceOf(NotFoundException)
  })
})

// ============================================================================
// Download / preview
// ============================================================================

describe("GestaoTarefasGlobalAnexosService — baixar (download/preview)", () => {
  async function montarAnexo(
    chave: string,
    conteudo: Buffer,
    override?: Partial<Record<string, unknown>>,
  ) {
    const fixture = {
      tarefas: [TAREFA],
      colaboradores: COLABORADORES,
      anexos: [{ ...ANEXO_ORG, ...override, chaveArmazenamento: chave }],
    }
    const db = dbFake(fixture)
    const caminho = caminhoFisico(chave)
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(caminho, ".."), { recursive: true })
    await writeFile(caminho, conteudo)
    return { db, svc: service(db), fixture }
  }

  it("pdf: StreamableFile com Content-Type application/pdf e disposition INLINE", async () => {
    const conteudo = Buffer.from("%PDF-1.7 conteudo")
    const { svc } = await montarAnexo(ANEXO_ORG.chaveArmazenamento as string, conteudo)

    const arquivo = await svc.baixar(PROJETO, ctx(), 42, 77)
    expect(arquivo).toBeInstanceOf(StreamableFile)
    const headers = arquivo.getHeaders()
    expect(headers.type).toBe("application/pdf")
    expect(String(headers.disposition).startsWith("inline")).toBe(true)
    expect(String(headers.disposition)).toContain("relatorio.pdf")
    expect(headers.length).toBe(conteudo.length)

    let recebido = Buffer.alloc(0)
    for await (const chunk of arquivo.getStream()) {
      recebido = Buffer.concat([recebido, chunk as Buffer])
    }
    expect(recebido.equals(conteudo)).toBe(true)
  })

  it("png: inline; txt: ATTACHMENT (nem todo tipo é renderizável inline)", async () => {
    const pngChave = "org/10/tarefa/42/22222222-2222-4222-8222-222222222222.png"
    const { svc: svcPng } = await montarAnexo(
      pngChave,
      Buffer.from("PNGDADOS"),
      { nomeArquivo: "logo.png", mimeType: "image/png" },
    )
    const png = await svcPng.baixar(PROJETO, ctx(), 42, 77)
    expect(String(png.getHeaders().disposition).startsWith("inline")).toBe(true)
    expect(png.getHeaders().type).toBe("image/png")

    const txtChave = "org/10/tarefa/42/33333333-3333-4333-8333-333333333333.txt"
    const { svc: svcTxt } = await montarAnexo(
      txtChave,
      Buffer.from("texto simples"),
      { nomeArquivo: "notas.txt", mimeType: "text/plain" },
    )
    const txt = await svcTxt.baixar(PROJETO, ctx(), 42, 77)
    expect(String(txt.getHeaders().disposition).startsWith("attachment")).toBe(true)
    expect(txt.getHeaders().type).toBe("text/plain")
  })

  it("404: anexo de OUTRA organização (não vaza existência)", async () => {
    const conteudo = Buffer.from("%PDF")
    const { svc } = await montarAnexo(
      ANEXO_ORG.chaveArmazenamento as string,
      conteudo,
      { organizacaoId: 99, chaveArmazenamento: "org/99/tarefa/42/44444444-4444-4444-8444-444444444444.pdf" },
    )
    // Sessão da org 10 buscando o anexo da org 99.
    await expect(svc.baixar(PROJETO, ctx(), 42, 77)).rejects.toBeInstanceOf(NotFoundException)
    await expect(svc.baixar(PROJETO, ctx(), 42, 77)).rejects.toThrow(/n[ãa]o encontrad[oa]/)
  })

  it("404: anexo que não pertence à tarefa informada", async () => {
    const conteudo = Buffer.from("%PDF")
    const { svc } = await montarAnexo(ANEXO_ORG.chaveArmazenamento as string, conteudo, {
      tarefaId: 999,
    })
    await expect(svc.baixar(PROJETO, ctx(), 42, 77)).rejects.toBeInstanceOf(NotFoundException)
  })

  it("404: linha existe mas arquivo ausente no armazenamento", async () => {
    const db = dbFake({
      tarefas: [TAREFA],
      colaboradores: COLABORADORES,
      anexos: [
        {
          ...ANEXO_ORG,
          chaveArmazenamento: "org/10/tarefa/42/55555555-5555-4555-8555-555555555555.pdf",
        },
      ],
    })
    const svc = service(db)
    await expect(svc.baixar(PROJETO, ctx(), 42, 77)).rejects.toBeInstanceOf(NotFoundException)
    await expect(svc.baixar(PROJETO, ctx(), 42, 77)).rejects.toThrow(/não disponível/)
  })

  it("404: chave com path traversal não escapa do ANEXOS_DIR", async () => {
    const db = dbFake({
      tarefas: [TAREFA],
      colaboradores: COLABORADORES,
      anexos: [
        { ...ANEXO_ORG, chaveArmazenamento: "../../etc/passwd" },
      ],
    })
    const svc = service(db)
    await expect(svc.baixar(PROJETO, ctx(), 42, 77)).rejects.toBeInstanceOf(NotFoundException)
  })
})

// ============================================================================
// Registro no histórico (append-only)
// ============================================================================

describe("GestaoTarefasGlobalAnexosService — histórico 'anexo'", () => {
  it("o upload insere EXATAMENTE um evento 'anexo' (append-only — nenhum update/delete no módulo)", async () => {
    const db = dbFake({ tarefas: [TAREFA], colaboradores: COLABORADORES })
    const svc = service(db)
    await svc.anexar(PROJETO, ctx(), 42, arquivo("h.txt", Buffer.from("x"), "text/plain"))

    const historico = db.insercoes.filter((i) => i.tabela === "historico_tarefas")
    expect(historico).toHaveLength(1)
    expect(historico[0]!.valores.tipoEvento).toBe("anexo")
    expect(String(historico[0]!.valores.mensagem)).toContain("h.txt")
    expect(db.transacoes.length).toBe(1)
    expect(db.transacoes[0]).toEqual({ inicio: true, fim: true, erro: null })
  })
})
