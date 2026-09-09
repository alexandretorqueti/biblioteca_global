import { configuracaoPorChave, MOTOR_CONFIGURACOES } from "../api/motor-configuracoes.catalog"

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

  it("expõe metadados suficientes para a tela editar cada valor", () => {
    expect(MOTOR_CONFIGURACOES.every((config) =>
      config.chave.startsWith("motor.") &&
      ["number", "string", "boolean"].includes(config.tipo),
    )).toBe(true)
  })
})
