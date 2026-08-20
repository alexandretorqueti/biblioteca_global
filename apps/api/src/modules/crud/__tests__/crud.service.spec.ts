// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import { componentes } from "../../../../../../projects/documentacao/schema"
import { tarefas as tarefasGerente } from "../../../../../../projects/gerenteagentes/schema"
import { CrudService, RESOURCES_RESERVADOS } from "../crud.service"
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
    const service = new CrudService(
      registry,
      factory as unknown as ProjectDbFactory,
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

    it("criar com chaves camelCase do formulário (projetoId/agenteId) → mapeadas p/ snake_case e aceitas", async () => {
      const { service, factory } = novoService()
      // Se o zod rejeitasse as chaves camelCase, o banco não seria acionado.
      await expect(
        service.criar(projeto("gerenteagentes", 3), "tarefas", {
          projetoId: 1,
          agenteId: 2,
          titulo: "Tarefa via formulário",
        }),
      ).rejects.toThrow("database não deveria ser acionado neste teste")
      expect(factory.chamadas).toBe(1)
    })

    it("criar com chave camelCase inexistente no schema → 400 sem tocar no banco", async () => {
      const { service, factory } = novoService()
      await expect(
        service.criar(projeto("gerenteagentes", 3), "tarefas", {
          projetoId: 1,
          agenteId: 2,
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
