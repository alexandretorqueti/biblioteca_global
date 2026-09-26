// @vitest-environment node
import { describe, expect, it } from "vitest"
import { BadRequestException } from "@nestjs/common"
import { sanitizarProjetoPublico, validarConfigDb } from "../projetos.service"
import type { ProjetoRow } from "../projetos.repository"

/** Factory de ProjetoRow para testes. */
function makeProjeto(overrides: Partial<ProjetoRow> = {}): ProjetoRow {
  return {
    id: 1,
    nome: "Teste",
    slug: "teste",
    ativo: true,
    config: { app: { name: "Teste" }, groups: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe("validarConfigDb", () => {
  it("retorna undefined quando todos os campos estão vazios", () => {
    expect(validarConfigDb({})).toBeUndefined()
    expect(validarConfigDb({ dbHost: "", dbDatabase: "", dbUser: "", dbPassword: "" })).toBeUndefined()
  })

  it("retorna config completa quando todos os campos estão preenchidos", () => {
    const config = validarConfigDb({
      dbHost: "dbaas.example.com",
      dbPort: 3306,
      dbDatabase: "meubanco",
      dbUser: "admin",
      dbPassword: "s3cret",
    })
    expect(config).toEqual({
      dbHost: "dbaas.example.com",
      dbPort: 3306,
      dbDatabase: "meubanco",
      dbUser: "admin",
      dbPassword: "s3cret",
    })
  })

  it("rejeita configuração parcialmente preenchida (falta senha)", () => {
    expect(() =>
      validarConfigDb({
        dbHost: "dbaas.example.com",
        dbPort: 3306,
        dbDatabase: "meubanco",
        dbUser: "admin",
      }),
    ).toThrow(BadRequestException)
  })

  it("rejeita configuração parcialmente preenchida (falta host)", () => {
    try {
      validarConfigDb({
        dbPort: 3306,
        dbDatabase: "meubanco",
        dbUser: "admin",
        dbPassword: "s3cret",
      })
      expect.unreachable("deveria ter lançado")
    } catch (erro: unknown) {
      expect(erro).toBeInstanceOf(BadRequestException)
      const resp = (erro as BadRequestException).getResponse() as Record<string, unknown>
      expect(resp.camposFaltantes).toContain("dbHost")
    }
  })

  it("rejeita configuração parcialmente preenchida (apenas host)", () => {
    try {
      validarConfigDb({ dbHost: "host" })
      expect.unreachable("deveria ter lançado")
    } catch (erro: unknown) {
      expect(erro).toBeInstanceOf(BadRequestException)
    }
  })

  it("trim de espaços em branco", () => {
    const config = validarConfigDb({
      dbHost: "  dbaas.example.com  ",
      dbPort: 3306,
      dbDatabase: "meubanco",
      dbUser: "admin",
      dbPassword: "s3cret",
    })
    expect(config?.dbHost).toBe("dbaas.example.com")
  })
})

describe("sanitizarProjetoPublico", () => {
  it("remove dbPasswordCriptografado e adiciona dbPasswordConfigurado=true", () => {
    const projeto = makeProjeto({
      dbHost: "dbaas.example.com",
      dbPort: 3306,
      dbDatabase: "meubanco",
      dbUser: "admin",
      dbPasswordCriptografado: "iv:tag:ciphertext",
    })

    const sanitized = sanitizarProjetoPublico(projeto)

    expect(sanitized).not.toHaveProperty("dbPasswordCriptografado")
    expect(sanitized.dbPasswordConfigurado).toBe(true)
    expect(sanitized.dbHost).toBe("dbaas.example.com")
  })

  it("dbPasswordConfigurado=false quando não há senha criptografada", () => {
    const projeto = makeProjeto()
    const sanitized = sanitizarProjetoPublico(projeto)

    expect(sanitized.dbPasswordConfigurado).toBe(false)
    expect(sanitized).not.toHaveProperty("dbPasswordCriptografado")
  })

  it("não altera os demais campos do projeto", () => {
    const projeto = makeProjeto({ nome: "Meu Projeto", slug: "meu-projeto" })
    const sanitized = sanitizarProjetoPublico(projeto)

    expect(sanitized.nome).toBe("Meu Projeto")
    expect(sanitized.slug).toBe("meu-projeto")
    expect(sanitized.id).toBe(1)
  })
})
