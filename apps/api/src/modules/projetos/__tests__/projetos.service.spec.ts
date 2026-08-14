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

class FakeProjetosRepository implements ProjetosRepository {
  projetos: ProjetoRow[] = []
  chamadas: string[] = []
  private proximoId = 1

  async listar(): Promise<ProjetoRow[]> {
    return this.projetos
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
    config: GeradorSistemaConfig
  }): Promise<number> {
    const id = this.proximoId++
    this.projetos.push({
      id,
      nome: row.nome,
      slug: row.slug,
      ativo: true,
      config: row.config,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    this.chamadas.push(`criar:${row.slug}`)
    return id
  }

  async atualizar(
    id: number,
    campos: Partial<{ nome: string; ativo: boolean; config: GeradorSistemaConfig }>,
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
    service = new ProjetosService(repo, provisioner)
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
})
