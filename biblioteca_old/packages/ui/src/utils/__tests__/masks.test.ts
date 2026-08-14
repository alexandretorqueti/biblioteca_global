import { describe, expect, it } from "vitest"
import { formatCnpj, isValidCnpj } from "../masks"

describe("máscara e validação de CNPJ", () => {
  it("formata CNPJ progressivamente", () => {
    expect(formatCnpj("05064544000130")).toBe("05.064.544/0001-30")
  })

  it("valida um CNPJ correto", () => {
    expect(isValidCnpj("05.064.544/0001-30")).toBe(true)
  })

  it("rejeita CNPJ repetido", () => {
    expect(isValidCnpj("11.111.111/1111-11")).toBe(false)
  })
})
