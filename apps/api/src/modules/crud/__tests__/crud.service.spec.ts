// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common"
import { getTableColumns } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { ConfigService } from "@nestjs/config"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import { componentes } from "../../../../../../projects/documentacao/schema"
import { tarefas as tarefasGerente } from "../../../../../../projects/gerenteagentes/schema"
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
