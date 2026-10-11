import { configuracaoPorChave, MOTOR_CONFIGURACOES } from "../api/motor-configuracoes.catalog"
import { DEFAULT_TIMEZONE } from "../src/shared/timezone"

describe("catálogo de configurações do motor", () => {
  it("tem chaves únicas e defaults válidos", () => {
    const chaves = MOTOR_CONFIGURACOES.map((config) => config.chave)
    expect(new Set(chaves).size).toBe(chaves.length)
    for (const config of MOTOR_CONFIGURACOES) {
      expect(config.descricao).not.toBe("")
      expect(config.regraValidacao).not.toBe("")
      expect(config.validar(config.valorPadrao)).toBe(true)
    }
  })

  it("valida o limite de paralelismo", () => {
    const config = configuracaoPorChave("motor.max_workers")!
    expect(config.validar(1)).toBe(true)
    expect(config.validar(0)).toBe(false)
    expect(config.validar(101)).toBe(false)
    expect(config.validar("2")).toBe(false)
  })

  it("expõe e valida o limite de entregas", () => {
    const config = configuracaoPorChave("motor.max_delivery_attempts")!
    expect(config.valorPadrao).toBe(20)
    expect(config.validar(1)).toBe(true)
    expect(config.validar(20)).toBe(true)
    expect(config.validar(0)).toBe(false)
    expect(config.validar(201)).toBe(false)
  })

  it("expõe metadados suficientes para a tela editar cada valor", () => {
    expect(MOTOR_CONFIGURACOES.every((config) =>
      config.chave.startsWith("motor.") &&
      ["number", "string", "boolean"].includes(config.tipo),
    )).toBe(true)
  })

  describe("motor.timezone", () => {
    it("existe no catálogo com padrão America/Sao_Paulo", () => {
      const config = configuracaoPorChave("motor.timezone")!
      expect(config).toBeDefined()
      expect(config.chave).toBe("motor.timezone")
      expect(config.tipo).toBe("string")
      expect(config.valorPadrao).toBe(DEFAULT_TIMEZONE)
      expect(config.regraValidacao).toContain("IANA")
    })

    it("aceita identificadores IANA válidos", () => {
      const config = configuracaoPorChave("motor.timezone")!
      expect(config.validar("America/Sao_Paulo")).toBe(true)
      expect(config.validar("America/New_York")).toBe(true)
      expect(config.validar("Europe/London")).toBe(true)
      expect(config.validar("UTC")).toBe(true)
    })

    it("rejeita valores inválidos", () => {
      const config = configuracaoPorChave("motor.timezone")!
      expect(config.validar("")).toBe(false)
      expect(config.validar("Invalid/Zone")).toBe(false)
      expect(config.validar(42)).toBe(false)
      expect(config.validar(null)).toBe(false)
      expect(config.validar(undefined)).toBe(false)
    })
  })
})
