// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest"
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"
import {
  configPadrao,
  nomeDatabaseDoProjeto,
  ProjetosService,
} from "../projetos.service"
import type { ProjetoProvisioner } from "../provisioner.service"
import type { ProjetoRow, ProjetosRepository } from "../projetos.repository"
import type { SchemaRegistry } from "../../crud/schema-registry"

// Configura variável de ambiente para criptografia de credenciais nos testes.
process.env.DB_CREDENTIALS_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

class FakeSchemaRegistry implements SchemaRegistry {
  tabelasDoProjeto(): undefined {
    return undefined
  }
  projetosCarregados(): string[] {
    return []
  }
}

class FakeProjetosRepository implements ProjetosRepository {
  projetos: ProjetoRow[] = []
  chamadas: string[] = []
  private proximoId = 1

  async listar(filtros: {
    page: number
    pageSize: number
  }): Promise<{ items: ProjetoRow[]; total: number }> {
    const inicio = (filtros.page - 1) * filtros.pageSize
    return {
      items: this.projetos.slice(inicio, inicio + filtros.pageSize),
      total: this.projetos.length,
    }
  }

  async findById(id: number): Promise<ProjetoRow | undefined> {
    return this.projetos.find((p) => p.id === id)
  }

  async findBySlug(slug: string): Promise<ProjetoRow | undefined> {
    return this.projetos.find((p) => p.slug === slug)
  }

  async criar(row: {
    nome: string
    slug: string
    ativo?: boolean
    config: GeradorSistemaConfig
    dbHost?: string
    dbPort?: number
    dbDatabase?: string
    dbUser?: string
    dbPasswordCriptografado?: string
  }): Promise<number> {
    const id = this.proximoId++
    this.projetos.push({
      id,
      nome: row.nome,
      slug: row.slug,
      ativo: true,
      config: row.config,
      dbHost: row.dbHost,
      dbPort: row.dbPort,
      dbDatabase: row.dbDatabase,
      dbUser: row.dbUser,
      dbPasswordCriptografado: row.dbPasswordCriptografado,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    this.chamadas.push(`criar:${row.slug}`)
    return id
  }

  async atualizar(
    id: number,
    campos: Partial<{
      nome: string
      ativo: boolean
      config: GeradorSistemaConfig
      dbHost: string | null
      dbPort: number | null
      dbDatabase: string | null
      dbUser: string | null
      dbPasswordCriptografado: string | null
    }>,
  ): Promise<void> {
    const projeto = this.projetos.find((p) => p.id === id)
    if (projeto) Object.assign(projeto, campos)
    this.chamadas.push(`atualizar:${id}`)
  }

  async remover(id: number): Promise<void> {
    this.projetos = this.projetos.filter((p) => p.id !== id)
    this.chamadas.push(`remover:${id}`)
  }
}

class FakeProvisioner implements ProjetoProvisioner {
  chamadas: string[] = []
  falharEm: "preparar" | "migrations" | undefined

  async prepararDatabase(database: string): Promise<void> {
    this.chamadas.push(`preparar:${database}`)
    if (this.falharEm === "preparar") {
      throw new Error("falha simulada no CREATE DATABASE")
    }
  }

  async aplicarMigrations(slug: string, database: string): Promise<number> {
    this.chamadas.push(`migrations:${slug}:${database}`)
    if (this.falharEm === "migrations") {
      throw new Error("falha simulada nas migrations")
    }
    return 2
  }

  async removerDatabase(database: string): Promise<void> {
    this.chamadas.push(`removerDatabase:${database}`)
  }
}

describe("ProjetosService", () => {
  let repo: FakeProjetosRepository
  let provisioner: FakeProvisioner
  let service: ProjetosService

  beforeEach(() => {
    repo = new FakeProjetosRepository()
    provisioner = new FakeProvisioner()
    service = new ProjetosService(repo, provisioner, new FakeSchemaRegistry())
  })

  describe("listar (paginação padronizada)", () => {
    it("retorna PaginatedResult com page/pageSize defaults", async () => {
      await service.criar({ nome: "A", slug: "a", config: configPadrao("A") })
      await service.criar({ nome: "B", slug: "b", config: configPadrao("B") })

      const resultado = await service.listar({})
      expect(resultado.items).toHaveLength(2)
      expect(resultado.total).toBe(2)
      expect(resultado.page).toBe(1)
      expect(resultado.pageSize).toBe(20)
    })

    it("aplica page/pageSize e valida o teto de 100", async () => {
      const resultado = await service.listar({ page: 1, pageSize: 10 })
      expect(resultado.page).toBe(1)
      expect(resultado.pageSize).toBe(10)

      await expect(
        service.listar({ page: 0, pageSize: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException)
      await expect(
        service.listar({ page: 1, pageSize: 101 }),
      ).rejects.toBeInstanceOf(BadRequestException)
    })
  })

  describe("criar (ciclo de vida)", () => {
    it("registro → CREATE DATABASE projeto_<id> → migrations", async () => {
      const criado = await service.criar({
        nome: "Projeto Teste",
        slug: "projeto-teste",
      })
      expect(criado.id).toBe(1)
      expect(criado.database).toBe("projeto_1")
      expect(provisioner.chamadas).toEqual([
        "preparar:projeto_1",
        "migrations:projeto-teste:projeto_1",
      ])
      expect(criado.migrationsAplicadas).toBe(2)
      expect(criado.config).toEqual(configPadrao("Projeto Teste"))
    })

    it("config fornecida é validada e salva", async () => {
      const config: GeradorSistemaConfig = {
        app: { name: "X" },
        groups: [],
      }
      const criado = await service.criar({
        nome: "Com Config",
        slug: "com-config",
        config,
      })
      expect(criado.config).toEqual(config)
    })

    it("config inválida (campo inexistente) → 400", async () => {
      const configRuim = {
        app: { name: "X" },
        groups: [],
        campoSurpresa: 1,
      } as unknown as GeradorSistemaConfig
      await expect(
        service.criar({
          nome: "Config Ruim",
          slug: "config-ruim",
          config: configRuim,
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(repo.chamadas).not.toContain("criar:config-ruim")
    })

    it("slug duplicado → 409", async () => {
      await service.criar({ nome: "A", slug: "mesmo-slug" })
      await expect(
        service.criar({ nome: "B", slug: "mesmo-slug" }),
      ).rejects.toBeInstanceOf(ConflictException)
    })

    it("falha no provisionamento → compensação (desfaz registro e database)", async () => {
      provisioner.falharEm = "migrations"
      await expect(
        service.criar({ nome: "Vai Falhar", slug: "vai-falhar" }),
      ).rejects.toThrow("falha simulada")
      expect(repo.chamadas).toContain("remover:1")
      expect(provisioner.chamadas).toContain("removerDatabase:projeto_1")
      expect(repo.projetos).toHaveLength(0)
    })

    it("falha no CREATE DATABASE → compensação também", async () => {
      provisioner.falharEm = "preparar"
      await expect(
        service.criar({ nome: "Vai Falhar", slug: "vai-falhar2" }),
      ).rejects.toThrow("falha simulada")
      expect(repo.projetos).toHaveLength(0)
    })
  })

  describe("atualizar", () => {
    it("valida a config antes de salvar", async () => {
      await service.criar({ nome: "P", slug: "p" })
      await expect(
        service.atualizar(1, {
          config: {
            app: { name: "P" },
            groups: [{ id: "g", label: "G", items: [] }],
            drawerWidth: -5,
          },
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it("salva config válida", async () => {
      await service.criar({ nome: "P", slug: "p2" })
      const atualizado = await service.atualizar(1, {
        nome: "P2",
        config: { app: { name: "P2" }, groups: [] },
      })
      expect(atualizado.nome).toBe("P2")
      expect(atualizado.config.app.name).toBe("P2")
    })

    it("projeto inexistente → 404", async () => {
      await expect(service.atualizar(999, { nome: "X" })).rejects.toBeInstanceOf(
        NotFoundException,
      )
    })

    it("slug é imutável: mudança → 400; mesmo slug → ok", async () => {
      await service.criar({ nome: "P", slug: "p-imutavel" })
      await expect(
        service.atualizar(1, { slug: "outro-slug" }),
      ).rejects.toBeInstanceOf(BadRequestException)
      const atualizado = await service.atualizar(1, { slug: "p-imutavel" })
      expect(atualizado.slug).toBe("p-imutavel")
    })
  })

  describe("desativar (soft delete)", () => {
    it("desativa preservando o registro", async () => {
      await service.criar({ nome: "P", slug: "p3" })
      await service.desativar(1)
      const projeto = repo.projetos.find((p) => p.id === 1)
      expect(projeto?.ativo).toBe(false)
    })
  })

  it("nomeDatabaseDoProjeto deriva do id", () => {
    expect(nomeDatabaseDoProjeto(7)).toBe("projeto_7")
  })

  describe("criar com conexão MySQL customizada", () => {
    it("projeto com config customizada NÃO recebe provisionamento automático", async () => {
      const criado = await service.criar({
        nome: "Projeto Externo",
        slug: "projeto-externo",
        dbHost: "dbaas.example.com",
        dbPort: 3306,
        dbDatabase: "meubanco",
        dbUser: "admin",
        dbPassword: "s3cret",
      })
      expect(criado.id).toBe(1)
      expect(criado.database).toBe("meubanco") // retorna o database externo, não projeto_<id>
      expect(criado.migrationsAplicadas).toBe(0)
      expect(criado.dbHost).toBe("dbaas.example.com")
      expect(criado.dbPort).toBe(3306)
      expect(criado.dbDatabase).toBe("meubanco")
      expect(criado.dbUser).toBe("admin")
      expect(criado.dbPasswordConfigurado).toBe(true)
      // Provisionamento NÃO foi chamado
      expect(provisioner.chamadas).not.toContain("preparar:projeto_1")
      expect(provisioner.chamadas).not.toContain("migrations:projeto-externo:projeto_1")
    })

    it("configuração parcialmente preenchida é rejeitada", async () => {
      await expect(
        service.criar({
          nome: "Projeto Incompleto",
          slug: "projeto-incompleto",
          dbHost: "dbaas.example.com",
          dbPort: 3306,
          // falta dbDatabase, dbUser, dbPassword
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(repo.projetos).toHaveLength(0)
    })

    it("projeto sem config customizada recebe provisionamento normal", async () => {
      const criado = await service.criar({
        nome: "Projeto Padrão",
        slug: "projeto-padrao",
      })
      expect(criado.database).toBe("projeto_1")
      expect(criado.migrationsAplicadas).toBe(2)
      expect(provisioner.chamadas).toContain("preparar:projeto_1")
      expect(provisioner.chamadas).toContain("migrations:projeto-padrao:projeto_1")
    })
  })

  describe("atualizar com conexão MySQL customizada", () => {
    it("adiciona config customizada em projeto existente", async () => {
      await service.criar({ nome: "P", slug: "p" })
      const atualizado = await service.atualizar(1, {
        dbHost: "dbaas.example.com",
        dbPort: 3306,
        dbDatabase: "meubanco",
        dbUser: "admin",
        dbPassword: "s3cret",
      })
      expect(atualizado.dbHost).toBe("dbaas.example.com")
      expect(atualizado.dbPort).toBe(3306)
      expect(atualizado.dbDatabase).toBe("meubanco")
      expect(atualizado.dbUser).toBe("admin")
      expect(atualizado.dbPasswordConfigurado).toBe(true)
    })

    it("remove config customizada ao enviar campo vazio", async () => {
      await service.criar({
        nome: "P",
        slug: "p",
        dbHost: "dbaas.example.com",
        dbPort: 3306,
        dbDatabase: "meubanco",
        dbUser: "admin",
        dbPassword: "s3cret",
      })
      const atualizado = await service.atualizar(1, {
        dbHost: "", // remove a config
      })
      expect(atualizado.dbHost).toBeNull()
      expect(atualizado.dbPort).toBeNull()
      expect(atualizado.dbDatabase).toBeNull()
      expect(atualizado.dbUser).toBeNull()
      expect(atualizado.dbPasswordConfigurado).toBe(false)
    })

    it("edição sem campos de conexão não altera config existente", async () => {
      await service.criar({
        nome: "P",
        slug: "p",
        dbHost: "dbaas.example.com",
        dbPort: 3306,
        dbDatabase: "meubanco",
        dbUser: "admin",
        dbPassword: "s3cret",
      })
      const atualizado = await service.atualizar(1, {
        nome: "Novo Nome",
      })
      expect(atualizado.nome).toBe("Novo Nome")
      expect(atualizado.dbHost).toBe("dbaas.example.com") // preservado
      expect(atualizado.dbPasswordConfigurado).toBe(true)
    })

    it("atualiza apenas a senha quando enviada", async () => {
      await service.criar({
        nome: "P",
        slug: "p",
        dbHost: "dbaas.example.com",
        dbPort: 3306,
        dbDatabase: "meubanco",
        dbUser: "admin",
        dbPassword: "s3cret",
      })
      const atualizado = await service.atualizar(1, {
        dbPassword: "nova_senha",
      })
      expect(atualizado.dbHost).toBe("dbaas.example.com") // preservado
      expect(atualizado.dbPasswordConfigurado).toBe(true)
    })
  })
})
