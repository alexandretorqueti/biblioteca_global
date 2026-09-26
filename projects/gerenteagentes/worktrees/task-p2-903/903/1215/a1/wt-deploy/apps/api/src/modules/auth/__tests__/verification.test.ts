// @vitest-environment node
/**
 * Testes do núcleo determinístico do código de verificação (Etapa 4).
 * Código puro — sem Nest, sem banco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { randomInt } from "crypto"

// Mock do node:crypto com randomInt espiável — preserva o restante.
// O tipo em runtime vira vi.fn; o cast abaixo expõe a superfície de mock.
vi.mock("crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("crypto")>()
  const fn = original.randomInt as unknown as (
    min: number,
    max: number,
  ) => number
  return { ...original, randomInt: vi.fn((min: number, max: number) => fn(min, max)) }
})

const randomIntMock = randomInt as unknown as {
  mockReturnValueOnce(value: number): unknown
  mockClear(): void
}

import {
  CODIGO_LENGTH,
  generateCode,
  hashCode,
  isValidEmail,
  safeCompare,
} from "../verification"

const SECRET = "segredo-de-teste"

beforeEach(() => {
  randomIntMock.mockClear()
})

describe("verification — generateCode", () => {
  it("gera sempre 6 dígitos numéricos", () => {
    for (let i = 0; i < 200; i++) {
      const codigo = generateCode()
      expect(codigo).toMatch(/^\d{6}$/)
    }
  })

  it("preserva zeros à esquerda (000007, 000123)", () => {
    randomIntMock.mockReturnValueOnce(7)
    expect(generateCode()).toBe("000007")
    randomIntMock.mockReturnValueOnce(123)
    expect(generateCode()).toBe("000123")
  })

  it("gera códigos diferentes em chamadas seguidas", () => {
    const a = generateCode()
    const b = generateCode()
    // Probabilidade de colisão: 1/1e6 — aceitável como teste.
    expect(a).not.toBe(b)
  })
})

describe("verification — hashCode", () => {
  it("é determinístico para a mesma entrada (e-mail em lowercase)", () => {
    expect(hashCode("123456", "A@B.com", SECRET)).toBe(
      hashCode("123456", "a@b.com", SECRET),
    )
  })

  it("muda se o código muda", () => {
    expect(hashCode("123456", "a@b.com", SECRET)).not.toBe(
      hashCode("654321", "a@b.com", SECRET),
    )
  })

  it("muda se o e-mail muda", () => {
    expect(hashCode("123456", "a@b.com", SECRET)).not.toBe(
      hashCode("123456", "c@d.com", SECRET),
    )
  })

  it("produz hash de 64 chars hex (HMAC-SHA256)", () => {
    expect(hashCode("123456", "a@b.com", SECRET)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("nunca devolve o código em claro", () => {
    const hash = hashCode("123456", "a@b.com", SECRET)
    expect(hash).not.toContain("123456")
  })
})

describe("verification — safeCompare", () => {
  it("aceita strings idênticas", () => {
    expect(safeCompare("abc", "abc")).toBe(true)
  })

  it("rejeita strings diferentes do mesmo tamanho", () => {
    expect(safeCompare("abc", "abd")).toBe(false)
  })

  it("rejeita tamanhos diferentes sem timingSafeEqual", () => {
    expect(safeCompare("abc", "abcd")).toBe(false)
    expect(safeCompare("a", "b")).toBe(false)
  })

  it("rejeita vazio vs não-vazio", () => {
    expect(safeCompare("", "x")).toBe(false)
  })
})

describe("verification — isValidEmail", () => {
  it("aceita e-mails válidos", () => {
    for (const email of [
      "a@b.com",
      "alexandre@globaltecnologia.com.br",
      "nome.sobrenome+tag@sub.dominio.io",
    ]) {
      expect(isValidEmail(email)).toBe(true)
    }
  })

  it("rejeita e-mails inválidos", () => {
    for (const email of [
      "",
      "sem-arroba",
      "@sem-nome.com",
      "com-espaco@a b.com",
      "a@b",
      "a@.com",
    ]) {
      expect(isValidEmail(email)).toBe(false)
    }
  })
})

describe("verification — constantes de negócio", () => {
  it("código tem 6 dígitos (D5)", () => {
    expect(CODIGO_LENGTH).toBe(6)
  })
})
