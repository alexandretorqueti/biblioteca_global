import { describe, expect, it } from "vitest"
import { failureFingerprint, isSystemicFailure } from "../src/policies/SystemFailurePolicy.js"

describe("SystemFailurePolicy", () => {
  it("normaliza detalhes voláteis de uma falha", () => {
    expect(failureFingerprint("Testes falharam: porta 3001 ocupada no commit abcdef123456"))
      .toBe("testes falharam: porta <n> ocupada no commit <sha>")
  })

  it("classifica a mesma falha em dois modelos como sistêmica", () => {
    expect(isSystemicFailure([
      "Build falhou: conexão recusada na porta 3001",
      "Build falhou: conexão recusada na porta 3002",
    ])).toBe(true)
  })

  it("permite escalada quando as falhas são distintas", () => {
    expect(isSystemicFailure([
      "Build falhou: TypeScript error",
      "Testes falharam: assertion error",
    ])).toBe(false)
  })
})
