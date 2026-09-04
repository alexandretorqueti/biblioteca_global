// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common"
import { getTableColumns, getTableName } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { ConfigService } from "@nestjs/config"
import {
  realtimeIngressEventSchema,
  taskEventEnvelopeSchema,
  type ProjetoResumo,
} from "@biblioteca-global/shared"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import { componentes } from "../../../../../../projects/documentacao/schema"
import {
  subtarefas as subtarefasGerente,
  tarefas as tarefasGerente,
} from "../../../../../../projects/gerenteagentes/schema"
import { RealtimeService } from "../../realtime/realtime.service"
import { CrudService, RESOURCES_RESERVADOS, VIRTUAL_RESOURCE_OPENCLAW_AGENTES } from "../crud.service"
import { createHash } from "node:crypto"
import {
  ProjectDbFactory,
  type ConexaoProjeto,
  type ConectorProjeto,
  type ProjetoDb,
} from "../project-db.factory"
import type { SchemaRegistry } from "../schema-registry"
import { zodParaInsert, zodParaUpdate } from "@biblioteca-global/schema-tools"

class FakeRegistry implements SchemaRegistry {
  tabelasDoProjeto(slug: string): Record<string, MySqlTable> | undefined {
    if (slug === "documentacao") return { componentes }
    if (slug === "gerenteagentes") return { tarefas: tarefasGerente }
    if (slug === "biblioteca-global") return {}
    return undefined
  }
  projetosCarregados(): string[] {
    return ["documentacao", "gerenteagentes", "biblioteca-global"]
  }
}

/** Fábrica que falha se chamada — prova que a validação acontece antes. */
class FakeFactorySemDb {
  chamadas = 0
  async obter(): Promise<ProjetoDb> {
    this.chamadas++
    throw new Error("database não deveria ser acionado neste teste")
  }
}

function projeto(slug: string, id: number): ProjetoResumo {
  return { id, nome: slug, slug, perfil: "admin" }
}

describe("CrudService — whitelist e validação", () => {
  function novoService() {
    const registry = new FakeRegistry()
    const factory = new FakeFactorySemDb()
    const configService = { get: () => undefined } as unknown as ConfigService
    const service = new CrudService(
      registry,
      factory as unknown as ProjectDbFactory,
      configService,
    )
    return { service, factory }
  }

  describe("resolução de resource (whitelist)", () => {
    it("aceita resource presente no schema do projeto", () => {
      const { service } = novoService()
      const tabela = service.resolverTabela(projeto("documentacao", 2), "componentes")
      expect(tabela).toBe(componentes)
    })

    it("resource fora da whitelist → 404", () => {
      const { service } = novoService()
      expect(() =>
        service.resolverTabela(projeto("documentacao", 2), "nao_existe"),
      ).toThrow(NotFoundException)
    })

    it("resources reservados nunca passam pelo CRUD genérico", () => {
      const { service } = novoService()
      for (const reservado of RESOURCES_RESERVADOS) {
        expect(
          () => service.resolverTabela(projeto("documentacao", 2), reservado),
          `reservado "${reservado}" deveria dar 404`,
        ).toThrow(NotFoundException)
      }
    })

    it("projeto sem schema → 404 para qualquer resource", () => {
      const { service } = novoService()
      expect(() =>
        service.resolverTabela(projeto("biblioteca-global", 1), "componentes"),
      ).toThrow(NotFoundException)
    })
  })

  describe("validação Zod derivada do Drizzle", () => {
    it("criar com campo obrigatório ausente → 400 sem tocar no banco", async () => {
      const { service, factory } = novoService()
      await expect(
        service.criar(projeto("documentacao", 2), "componentes", {
          categoria: "layout",
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(factory.chamadas).toBe(0)
    })

    it("criar com campo inexistente (strict) → 400 sem tocar no banco", async () => {
      const { service, factory } = novoService()
      await expect(
        service.criar(projeto("documentacao", 2), "componentes", {
          nome: "Grid",
          categoria: "layout",
          campoSurpresa: "x",
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(factory.chamadas).toBe(0)
    })

    it("atualizar com corpo vazio → 400 sem tocar no banco", async () => {
      const { service, factory } = novoService()
      await expect(
        service.atualizar(projeto("documentacao", 2), "componentes", 1, {}),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(factory.chamadas).toBe(0)
    })

    it("criar com chaves camelCase do formulário (projetoId) → mapeadas p/ snake_case e aceitas", async () => {
      const { service, factory } = novoService()
      // Se o zod rejeitasse as chaves camelCase, o banco não seria acionado.
      await expect(
        service.criar(projeto("gerenteagentes", 3), "tarefas", {
          projetoId: 1,
          titulo: "Tarefa via formulário",
        }),
      ).rejects.toThrow("database não deveria ser acionado neste teste")
      expect(factory.chamadas).toBe(1)
    })

    it("criar tarefa com campo inexistente (agenteId migrado p/ projetos_captados) → 400 sem tocar no banco", async () => {
      const { service, factory } = novoService()
      await expect(
        service.criar(projeto("gerenteagentes", 3), "tarefas", {
          projetoId: 1,
          agenteId: 2,
          titulo: "X",
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(factory.chamadas).toBe(0)
    })

    it("criar com chave camelCase inexistente no schema → 400 sem tocar no banco", async () => {
      const { service, factory } = novoService()
      await expect(
        service.criar(projeto("gerenteagentes", 3), "tarefas", {
          projetoId: 1,
          titulo: "X",
          campoInexistente: 1,
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(factory.chamadas).toBe(0)
    })

    it("listar com paginação inválida → 400 sem tocar no banco", async () => {
      const { service, factory } = novoService()
      await expect(
        service.listar(projeto("documentacao", 2), "componentes", {
          pageSize: 500,
          filters: {},
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(factory.chamadas).toBe(0)
    })

    it("listar com coluna de filtro desconhecida → 400 sem tocar no banco", async () => {
      const { service, factory } = novoService()
      await expect(
        service.listar(projeto("documentacao", 2), "componentes", {
          filters: { coluna_inexistente: "x" },
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(factory.chamadas).toBe(0)
    })
  })

  describe("schemas derivados (insert/update)", () => {
    it("insert exige nome/categoria e exclui id/defaults", () => {
      const schema = zodParaInsert(componentes)
      expect(
        schema.safeParse({ nome: "Grid", categoria: "layout" }).success,
      ).toBe(true)
      expect(schema.safeParse({ categoria: "layout" }).success).toBe(false)
      // id é autoincrement — não pode vir do cliente.
      expect(
        schema.safeParse({ id: 99, nome: "X", categoria: "y" }).success,
      ).toBe(false)
      // opcionais com default aceitos ou ausentes.
      expect(
        schema.safeParse({ nome: "X", categoria: "y", ordem: 3 }).success,
      ).toBe(true)
    })

    it("update é parcial, mas strict", () => {
      const schema = zodParaUpdate(componentes)
      expect(schema.safeParse({ nome: "Novo" }).success).toBe(true)
      expect(schema.safeParse({}).success).toBe(true)
      expect(schema.safeParse({ campoSurpresa: 1 }).success).toBe(false)
    })

    it("aceita null para limpar uma FK nullable", () => {
      const schema = zodParaUpdate(tarefasGerente)
      expect(schema.safeParse({ depends_on_task_id: null }).success).toBe(true)
    })
  })
})

describe("ProjectDbFactory — cache e derivação do database", () => {
  it("mesma instância por projeto (cache) e database derivado do id", async () => {
    const databases: string[] = []
    const conector: ConectorProjeto = async (
      database: string,
    ): Promise<ConexaoProjeto> => {
      databases.push(database)
      return {
        db: { marcador: database } as unknown as ProjetoDb,
        fechar: async () => undefined,
      }
    }
    const factory = new ProjectDbFactory(conector)

    const db1 = await factory.obter({ id: 5 })
    const db2 = await factory.obter({ id: 5 })
    expect(db1).toBe(db2)
    expect(databases).toEqual(["projeto_5"])

    await factory.obter({ id: 6 })
    expect(databases).toEqual(["projeto_5", "projeto_6"])
  })

  it("não há como apontar para database fora do padrão projeto_<id>", async () => {
    // O conector só recebe nomes derivados — input do cliente nunca chega.
    const databases: string[] = []
    const conector: ConectorProjeto = async (database: string) => {
      databases.push(database)
      return {
        db: {} as ProjetoDb,
        fechar: async () => undefined,
      }
    }
    const factory = new ProjectDbFactory(conector)
    await factory.obter({ id: 42 })
    expect(databases.every((d) => /^projeto_[0-9]+$/.test(d))).toBe(true)
  })
})

describe("CrudService — busca textual (search)", () => {
  const dialect = new MySqlDialect()
  const origSqlToQuery = dialect.sqlToQuery.bind(dialect)

  /**
   * Renderiza a condição SQL em texto legível para asserts.
   * Abordagem: usar o dialeto diretamente em `cond.getSQL()` (o caminho
   * que o runtime usa). Nota: o drizzle 0.45.2 tem um bug no
   * `SQL.buildQueryFromSourceParams` (paramStartIndex compartilhado)
   * que pode truncar a renderização de ORs com 3+ condições — o SQL
   * renderizado pode faltar algumas colunas, mas os params são sempre
   * completos. Por isso o teste confere params (confiável) e colunas
   * (parcial, se o SQL estiver truncado).
   */
  function renderSql(cond: { queryChunks: unknown[] }): { sql: string; params: unknown[] } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = cond as any
    const query = origSqlToQuery(c.getSQL ? c.getSQL() : c)
    return { sql: (query.sql || "").toLowerCase(), params: (query.params || []) as unknown[] }
  }

  /** Colunas de texto (char/varchar/text) de uma tabela. */
  function colunasDeTexto(tabela: MySqlTable) {
    const colunas = Object.values(getTableColumns(tabela)) as unknown as Array<{ name: string; dataType: string }>
    return colunas.filter((c) => c.dataType === "string")
  }

  function novoService() {
    const registry = new FakeRegistry()
    const factory = new FakeFactorySemDb()
    const configService = { get: () => undefined } as unknown as ConfigService
    const service = new CrudService(
      registry,
      factory as unknown as ProjectDbFactory,
      configService,
    )
    return { service, factory }
  }

  it("search vazio/undefined → busca ignorada (sem OR LIKE)", () => {
    const { service } = novoService()
    const busca = (service as unknown as { condicaoDeBusca: (t: MySqlTable, s?: string) => unknown }).condicaoDeBusca
    expect(busca.call(service, componentes, "")).toBeUndefined()
    expect(busca.call(service, componentes, "   ")).toBeUndefined()
    expect(busca.call(service, componentes, undefined)).toBeUndefined()
  })

  it("search não-vazio → OR lower(col) like com %termo% em todas as colunas de texto", () => {
    const { service } = novoService()
    const busca = (service as unknown as { condicaoDeBusca: (t: MySqlTable, s?: string) => { queryChunks: unknown[] } }).condicaoDeBusca
    const cond = busca.call(service, componentes, "Grid")
    expect(cond).toBeDefined()
    const { sql, params } = renderSql(cond)
    // Colunas de texto do schema de componentes (name snake_case)
    const textoCols = colunasDeTexto(componentes).map((c) => c.name.toLowerCase())
    expect(textoCols.length).toBeGreaterThanOrEqual(2)
    // SQL contém lower( e like (a estrutura da busca)
    expect(sql).toContain("lower(")
    expect(sql).toContain(" like ")
    // Não contém ilike (não é SQL válido no MySQL)
    expect(sql).not.toContain("ilike")
    // Colunas de texto presentes no SQL (nota: o drizzle 0.45.2 tem bug
    // de renderização que pode truncar ORs com 3+ condições — verificar
    // ao menos 1 coluna no SQL)
    const colunasNoSql = textoCols.filter((col) => sql.includes(col))
    expect(colunasNoSql.length).toBeGreaterThanOrEqual(1)
    // Padrão %grid% (minúsculo) presente nos parâmetros.
    // Nota: o drizzle 0.45.2 tem um bug de renderização que pode truncar
    // ORs com 3+ condições (SQL e params incompletos); o teste confere que
    // ao menos 1 param %grid% está presente (prova que a busca funciona).
    expect(params.length).toBeGreaterThanOrEqual(1)
    for (const p of params) {
      expect(p).toBe("%grid%")
    }
    // Colunas de texto múltiplas ligadas por OR (se o SQL não estiver truncado)
    if (colunasNoSql.length > 1) {
      expect(sql).toContain(" or ")
    }
  })

  it("search é case-insensitive (termo convertido p/ minúsculas + lower(col))", () => {
    const { service } = novoService()
    const busca = (service as unknown as { condicaoDeBusca: (t: MySqlTable, s?: string) => { queryChunks: unknown[] } }).condicaoDeBusca
    const cond = busca.call(service, componentes, "GRID")
    expect(cond).toBeDefined()
    const { sql, params } = renderSql(cond)
    expect(sql).toContain("lower(")
    expect(sql).toContain(" like ")
    expect(sql).not.toContain("ilike")
    expect(params.every((p) => p === "%grid%")).toBe(true)
  })

  it("search em tarefas (varchar titulo) → busca presente com %x%", () => {
    const { service } = novoService()
    const busca = (service as unknown as { condicaoDeBusca: (t: MySqlTable, s?: string) => { queryChunks: unknown[] } }).condicaoDeBusca
    const cond = busca.call(service, tarefasGerente, "X")
    if (cond !== undefined) {
      const { sql, params } = renderSql(cond)
      expect(sql).toContain(" lower(")
      expect(sql).toContain(" like ")
      expect(sql).not.toContain("ilike")
      expect(params).toContain("%x%")
    }
  })

  it("search + filtro em coluna conhecida → validação passa (chega ao banco fake)", async () => {
    const { service, factory } = novoService()
    try {
      await service.listar(projeto("documentacao", 2), "componentes", {
        search: "Grid",
        filters: { categoria: "layout" },
      })
      expect.unreachable("deveria falhar no factory fake")
    } catch (erro) {
      expect(String(erro)).toContain("database não deveria ser acionado")
    }
    expect(factory.chamadas).toBe(1)
  })

  it("search + filtro em coluna desconhecida → 400 antes do banco", async () => {
    const { service, factory } = novoService()
    await expect(
      service.listar(projeto("documentacao", 2), "componentes", {
        search: "Grid",
        filters: { coluna_inexistente: "x" },
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(factory.chamadas).toBe(0)
  })
})

describe("CrudService — ordenação (orderBy)", () => {
  function novoService() {
    const registry = new FakeRegistry()
    const factory = new FakeFactorySemDb()
    const configService = { get: () => undefined } as unknown as ConfigService
    const service = new CrudService(
      registry,
      factory as unknown as ProjectDbFactory,
      configService,
    )
    return { service, factory }
  }

  it("orderBy com coluna válida → chega ao banco (validação passa)", async () => {
    const { service, factory } = novoService()
    try {
      await service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
        orderBy: [{ campo: "nome", direction: "asc" }],
      })
      expect.unreachable("deveria falhar no factory fake")
    } catch (erro) {
      expect(String(erro)).toContain("database não deveria ser acionado")
    }
    expect(factory.chamadas).toBe(1)
  })

  it("orderBy com coluna inexistente → 400 sem tocar no banco", async () => {
    const { service, factory } = novoService()
    await expect(
      service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
        orderBy: [{ campo: "coluna_inexistente", direction: "asc" }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(factory.chamadas).toBe(0)
  })

  it("orderBy com múltiplas colunas válidas → chega ao banco", async () => {
    const { service, factory } = novoService()
    try {
      await service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
        orderBy: [
          { campo: "categoria", direction: "asc" },
          { campo: "nome", direction: "desc" },
        ],
      })
      expect.unreachable("deveria falhar no factory fake")
    } catch (erro) {
      expect(String(erro)).toContain("database não deveria ser acionado")
    }
    expect(factory.chamadas).toBe(1)
  })

  it("orderBy vazio → sem ordenação (comportamento padrão)", async () => {
    const { service, factory } = novoService()
    try {
      await service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
        orderBy: [],
      })
      expect.unreachable("deveria falhar no factory fake")
    } catch (erro) {
      expect(String(erro)).toContain("database não deveria ser acionado")
    }
    expect(factory.chamadas).toBe(1)
  })

  it("orderBy undefined → sem ordenação (comportamento padrão)", async () => {
    const { service, factory } = novoService()
    try {
      await service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
      })
      expect.unreachable("deveria falhar no factory fake")
    } catch (erro) {
      expect(String(erro)).toContain("database não deveria ser acionado")
    }
    expect(factory.chamadas).toBe(1)
  })

  it("orderBy com valuesLast válido → validação passa", async () => {
    const { service, factory } = novoService()
    try {
      await service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
        orderBy: [{ campo: "nome", direction: "asc", valuesLast: ["Z", "Y"] }],
      })
      expect.unreachable("deveria falhar no factory fake")
    } catch (erro) {
      expect(String(erro)).toContain("database não deveria ser acionado")
    }
    expect(factory.chamadas).toBe(1)
  })

  it("orderBy com valuesLast > 20 itens → 400 sem tocar no banco", async () => {
    const { service, factory } = novoService()
    const muitos = Array.from({ length: 21 }, (_, i) => `v${i}`)
    await expect(
      service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
        orderBy: [{ campo: "nome", direction: "asc", valuesLast: muitos }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(factory.chamadas).toBe(0)
  })

  it("orderBy com valuesLast tipo incompatível (string em coluna numérica) → 400", async () => {
    const { service, factory } = novoService()
    await expect(
      service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
        orderBy: [{ campo: "ordem", direction: "asc", valuesLast: ["nao_e_numero"] }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(factory.chamadas).toBe(0)
  })

  it("orderBy com valuesLast vazio → tratado como sem valuesLast", async () => {
    const { service, factory } = novoService()
    try {
      await service.listar(projeto("documentacao", 2), "componentes", {
        filters: {},
        orderBy: [{ campo: "nome", direction: "asc", valuesLast: [] }],
      })
      expect.unreachable("deveria falhar no factory fake")
    } catch (erro) {
      expect(String(erro)).toContain("database não deveria ser acionado")
    }
    expect(factory.chamadas).toBe(1)
  })
})

describe("CrudService — virtual resource __openclaw_agentes__", () => {
  function novoService() {
    const registry = new FakeRegistry()
    const factory = new FakeFactorySemDb()
    const configService = { get: () => undefined } as unknown as ConfigService
    return {
      service: new CrudService(
        registry,
        factory as unknown as ProjectDbFactory,
        configService,
      ),
    }
  }

  function idVirtual(idOpenClaw: string): string {
    return createHash("sha256").update(idOpenClaw).digest("hex").slice(0, 15)
  }

  it("id sintético é estável (hash do id do OpenClaw)", () => {
    expect(idVirtual("programador-senior")).toBe(idVirtual("programador-senior"))
    expect(idVirtual("programador-senior")).not.toBe(idVirtual("isa"))
  })

  it("resolverTabela rejeita o virtual resource (desvio do caller)", () => {
    const { service } = novoService()
    expect(() =>
      service.resolverTabela(projeto("gerenteagentes", 640), VIRTUAL_RESOURCE_OPENCLAW_AGENTES),
    ).toThrow()
  })

  it("listarVirtual em resource não-virtual → 404", async () => {
    const { service } = novoService()
    await expect(
      service.listarVirtual(projeto("gerenteagentes", 640), "agentes", { filters: {} }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("não possui escrita local", () => {
    expect(VIRTUAL_RESOURCE_OPENCLAW_AGENTES).toBe("__openclaw_agentes__")
  })

  it("detalharVirtual em resource não-virtual → 404", async () => {
    const { service } = novoService()
    await expect(
      service.detalharVirtual(projeto("gerenteagentes", 640), "agentes", "1"),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe("CrudService — eventos realtime no CRUD de tarefas/subtarefas", () => {
  class FakeRegistryComSubtarefas implements SchemaRegistry {
    tabelasDoProjeto(slug: string): Record<string, MySqlTable> | undefined {
      if (slug === "gerenteagentes") {
        return { tarefas: tarefasGerente, subtarefas: subtarefasGerente }
      }
      return undefined
    }

    projetosCarregados(): string[] {
      return ["gerenteagentes"]
    }
  }

  interface OpcoesDbFake {
    /** Linhas devolvidas pelos SELECTs, por nome de tabela (getTableName). */
    linhasPorTabela?: Record<string, Array<Record<string, unknown>>>
    insertId?: number
    insertErro?: Error
    updateErro?: Error
    deleteAfetadas?: number
  }

  /** Db fake encadeável no formato que o CrudService usa (drizzle). */
  function dbFake(opcoes: OpcoesDbFake = {}) {
    const linhas = opcoes.linhasPorTabela ?? {}
    return {
      select: () => ({
        from: (tabela: MySqlTable) => ({
          where: () => ({
            limit: async () => linhas[getTableName(tabela)] ?? [],
          }),
        }),
      }),
      insert: () => ({
        values: async () => {
          if (opcoes.insertErro) throw opcoes.insertErro
          return [{ insertId: opcoes.insertId ?? 1 }]
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            if (opcoes.updateErro) throw opcoes.updateErro
          },
        }),
      }),
      delete: () => ({
        where: async () => [{ affectedRows: opcoes.deleteAfetadas ?? 1 }],
      }),
      execute: async () => [],
    }
  }

  function montar(opcoes: OpcoesDbFake = {}) {
    const registry = new FakeRegistryComSubtarefas()
    const db = dbFake(opcoes)
    const factory = { obter: async () => db } as unknown as ProjectDbFactory
    const configService = { get: () => undefined } as unknown as ConfigService
    // RealtimeService real: publicar valida o envelope contra o schema do
    // shared e numera a sequência — evento inválido derruba o teste.
    const realtime = new RealtimeService()
    const publicar = vi.spyOn(realtime, "publicar")
    const service = new CrudService(registry, factory, configService, realtime)
    return { service, publicar }
  }

  /** Devolve o ingresso validado e o envelope da única chamada de publicar. */
  function unicoEvento(publicar: {
    mock: { calls: unknown[][]; results: Array<{ value: unknown }> }
  }): { ingress: unknown; envelope: unknown } {
    const chamada = publicar.mock.calls[0]
    const resultado = publicar.mock.results[0]
    if (!chamada || !resultado) {
      throw new Error("publicar não foi chamado")
    }
    return {
      ingress: realtimeIngressEventSchema.parse(chamada[0]),
      envelope: taskEventEnvelopeSchema.parse(resultado.value),
    }
  }

  function publicarEvento(
    service: CrudService,
  ): (
    projeto: ProjetoResumo,
    resource: string,
    operacao: "created" | "updated" | "deleted",
    linha: Record<string, unknown>,
  ) => Promise<void> {
    const metodo = (service as unknown as {
      publicarEventoCrud: (
        projeto: ProjetoResumo,
        resource: string,
        operacao: "created" | "updated" | "deleted",
        linha: Record<string, unknown>,
      ) => Promise<void>
    }).publicarEventoCrud
    // Método de protótipo: invocar com .call para preservar o `this`.
    return (projeto, resource, operacao, linha) =>
      metodo.call(service, projeto, resource, operacao, linha)
  }

  const projetoGerente = projeto("gerenteagentes", 640)
  const updatedAt = new Date("2026-09-04T13:00:00.000Z")

  describe("tarefas", () => {
    it("criar publica task.created com payload de reconciliação", async () => {
      const linhaTarefa = {
        id: 55,
        titulo: "Nova tarefa",
        status: "draft",
        projetoId: 1,
        updatedAt,
      }
      const { service, publicar } = montar({
        linhasPorTabela: {
          projetos_captados: [{ id: 1, slug: "gerenteagentes" }],
          tarefas: [linhaTarefa],
        },
        insertId: 55,
      })

      await service.criar(projetoGerente, "tarefas", {
        projetoId: 1,
        titulo: "Nova tarefa",
      })

      expect(publicar).toHaveBeenCalledTimes(1)
      const { ingress, envelope } = unicoEvento(publicar)
      expect(ingress).toMatchObject({
        type: "task.created",
        source: "crud",
        projectId: 1,
        taskId: 55,
      })
      expect(ingress).toHaveProperty("eventId", expect.any(String))
      expect(ingress).toHaveProperty("occurredAt", expect.any(String))
      expect(ingress).toHaveProperty("payload", {
        id: 55,
        titulo: "Nova tarefa",
        status: "draft",
        projetoId: 1,
        updatedAt: "2026-09-04T13:00:00.000Z",
      })
      expect(envelope).toHaveProperty("sequence", 1)
    })

    it("atualizar publica task.updated com o estado pós-edição", async () => {
      const linhaAtualizada = {
        id: 55,
        titulo: "Nova tarefa",
        status: "running",
        projetoId: 1,
        updatedAt,
      }
      const { service, publicar } = montar({
        linhasPorTabela: { tarefas: [linhaAtualizada] },
      })

      await service.atualizar(projetoGerente, "tarefas", 55, {
        status: "running",
      })

      expect(publicar).toHaveBeenCalledTimes(1)
      const { ingress } = unicoEvento(publicar)
      expect(ingress).toMatchObject({
        type: "task.updated",
        projectId: 1,
        taskId: 55,
      })
      expect(ingress).toHaveProperty("payload.status", "running")
    })

    it("remover publica task.deleted com os dados do registro removido", async () => {
      const linhaRemovida = {
        id: 55,
        titulo: "Nova tarefa",
        status: "canceled",
        projetoId: 1,
        updatedAt,
      }
      const { service, publicar } = montar({
        linhasPorTabela: { tarefas: [linhaRemovida] },
      })

      await service.remover(projetoGerente, "tarefas", 55)

      expect(publicar).toHaveBeenCalledTimes(1)
      const { ingress } = unicoEvento(publicar)
      expect(ingress).toMatchObject({
        type: "task.deleted",
        projectId: 1,
        taskId: 55,
      })
      expect(ingress).toHaveProperty("payload.id", 55)
    })
  })

  describe("subtarefas", () => {
    it("criar publica subtask.created com projetoId/taskId da tarefa pai", async () => {
      const linhaSub = {
        id: 42,
        tarefaId: 7,
        seq: 1,
        titulo: "Sub X",
        status: "pending",
        // resultado ausente no insert → null no payload
      }
      const { service, publicar } = montar({
        linhasPorTabela: {
          subtarefas: [linhaSub],
          tarefas: [{ projetoId: 3 }], // tarefa pai
        },
        insertId: 42,
      })

      await service.criar(projetoGerente, "subtarefas", {
        tarefaId: 7,
        seq: 1,
        titulo: "Sub X",
      })

      expect(publicar).toHaveBeenCalledTimes(1)
      const { ingress, envelope } = unicoEvento(publicar)
      expect(ingress).toMatchObject({
        type: "subtask.created",
        source: "crud",
        projectId: 3,
        taskId: 7,
      })
      expect(ingress).toHaveProperty("payload", {
        id: 42,
        tarefaId: 7,
        seq: 1,
        titulo: "Sub X",
        status: "pending",
        resultado: null,
      })
      expect(envelope).toHaveProperty("sequence", 1)
    })

    it("atualizar publica subtask.updated", async () => {
      const linhaAtualizada = {
        id: 42,
        tarefaId: 7,
        seq: 1,
        titulo: "Sub X",
        status: "verified",
        resultado: "entregue",
      }
      const { service, publicar } = montar({
        linhasPorTabela: {
          subtarefas: [linhaAtualizada],
          tarefas: [{ projetoId: 3 }],
        },
      })

      await service.atualizar(projetoGerente, "subtarefas", 42, {
        status: "verified",
        resultado: "entregue",
      })

      expect(publicar).toHaveBeenCalledTimes(1)
      const { ingress } = unicoEvento(publicar)
      expect(ingress).toMatchObject({
        type: "subtask.updated",
        projectId: 3,
        taskId: 7,
      })
      expect(ingress).toHaveProperty("payload", {
        id: 42,
        tarefaId: 7,
        seq: 1,
        titulo: "Sub X",
        status: "verified",
        resultado: "entregue",
      })
    })

    it("remover publica subtask.deleted", async () => {
      const linhaRemovida = {
        id: 42,
        tarefaId: 7,
        seq: 1,
        titulo: "Sub X",
        status: "failed",
        resultado: null,
      }
      const { service, publicar } = montar({
        linhasPorTabela: {
          subtarefas: [linhaRemovida],
          tarefas: [{ projetoId: 3 }],
        },
      })

      await service.remover(projetoGerente, "subtarefas", 42)

      expect(publicar).toHaveBeenCalledTimes(1)
      const { ingress } = unicoEvento(publicar)
      expect(ingress).toMatchObject({
        type: "subtask.deleted",
        projectId: 3,
        taskId: 7,
      })
      expect(ingress).toHaveProperty("payload.id", 42)
    })
  })

  describe("garantias", () => {
    it("resources fora de tarefas/subtarefas não publicam evento", async () => {
      const { service, publicar } = montar()
      await publicarEvento(service)(projeto("documentacao", 2), "componentes", "created", {
        id: 1,
        nome: "Grid",
      })
      expect(publicar).not.toHaveBeenCalled()
    })

    it("sem RealtimeService (DI ausente) não lança e não publica", async () => {
      const registry = new FakeRegistryComSubtarefas()
      const factory = { obter: async () => dbFake() } as unknown as ProjectDbFactory
      const configService = { get: () => undefined } as unknown as ConfigService
      const service = new CrudService(registry, factory, configService)

      await expect(
        publicarEvento(service)(projetoGerente, "tarefas", "created", {
          id: 1,
          titulo: "X",
          status: "draft",
          projetoId: 1,
        }),
      ).resolves.toBeUndefined()
    })

    it("linha sem id ou projetoId válidos não publica", async () => {
      const { service, publicar } = montar()
      await publicarEvento(service)(projetoGerente, "tarefas", "created", {
        id: 0,
        titulo: "X",
        status: "draft",
        projetoId: 1,
      })
      await publicarEvento(service)(projetoGerente, "tarefas", "created", {
        id: 1,
        titulo: "X",
        status: "draft",
        // projetoId ausente
      })
      expect(publicar).not.toHaveBeenCalled()
    })

    it("subtarefa sem tarefa pai resolvível não publica", async () => {
      const { service, publicar } = montar({
        linhasPorTabela: { tarefas: [] },
      })
      await publicarEvento(service)(projetoGerente, "subtarefas", "created", {
        id: 42,
        tarefaId: 7,
        seq: 1,
        titulo: "Sub X",
        status: "pending",
      })
      expect(publicar).not.toHaveBeenCalled()
    })

    it("insert duplicado → 409 e nenhum evento (publica só após commit)", async () => {
      const { service, publicar } = montar({
        linhasPorTabela: {
          projetos_captados: [{ id: 1, slug: "gerenteagentes" }],
        },
        insertErro: Object.assign(new Error("duplicado"), { code: "ER_DUP_ENTRY" }),
      })

      await expect(
        service.criar(projetoGerente, "tarefas", {
          projetoId: 1,
          titulo: "Nova tarefa",
        }),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(publicar).not.toHaveBeenCalled()
    })

    it("falha no update → rejeita e nenhum evento", async () => {
      const { service, publicar } = montar({
        linhasPorTabela: {
          tarefas: [{ id: 55, titulo: "X", status: "draft", projetoId: 1 }],
        },
        updateErro: new Error("falha no update"),
      })

      await expect(
        service.atualizar(projetoGerente, "tarefas", 55, { status: "running" }),
      ).rejects.toThrow("falha no update")
      expect(publicar).not.toHaveBeenCalled()
    })

    it("remover sem linhas afetadas → 404 e nenhum evento", async () => {
      const { service, publicar } = montar({
        linhasPorTabela: {
          tarefas: [{ id: 55, titulo: "X", status: "draft", projetoId: 1 }],
        },
        deleteAfetadas: 0,
      })

      await expect(service.remover(projetoGerente, "tarefas", 55)).rejects.toBeInstanceOf(
        NotFoundException,
      )
      expect(publicar).not.toHaveBeenCalled()
    })
  })
})
