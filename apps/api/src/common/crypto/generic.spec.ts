// @vitest-environment node
import { describe, expect, it } from "vitest"
import { decryptValue, encryptValue } from "./generic"

const KEY_HEX = "a".repeat(64)

describe("criptografia genérica AES-256-GCM", () => {
  it("criptografa e descriptografa um valor", () => {
    const ctx = { keyHexOrBase64: KEY_HEX, keyEnvName: "TEST_KEY" }

    const encrypted = encryptValue("s3cret!", ctx)

    expect(encrypted.split(":")).toHaveLength(3)
    expect(encrypted).not.toContain("s3cret!")
    expect(decryptValue(encrypted, ctx)).toBe("s3cret!")
  })

  it("gera ciphertext diferente para o mesmo valor (IV aleatório)", () => {
    const ctx = { keyHexOrBase64: KEY_HEX, keyEnvName: "TEST_KEY" }

    expect(encryptValue("same", ctx)).not.toBe(encryptValue("same", ctx))
  })

  it("falha sem chave configurada", () => {
    const ctx = { keyHexOrBase64: "", keyEnvName: "TEST_KEY" }
    expect(() => encryptValue("x", ctx)).toThrow("TEST_KEY")
  })

  it("falha com chave de tamanho incorreto", () => {
    const ctx = { keyHexOrBase64: "aa", keyEnvName: "TEST_KEY" }
    expect(() => encryptValue("x", ctx)).toThrow("32 bytes")
  })

  it("falha com ciphertext em formato inválido", () => {
    const ctx = { keyHexOrBase64: KEY_HEX, keyEnvName: "TEST_KEY" }
    expect(() => decryptValue("invalido", ctx)).toThrow("formato inválido")
    expect(() => decryptValue("a:b", ctx)).toThrow("formato inválido")
  })

  it("aceita chave em base64", () => {
    const keyBase64 = Buffer.from("b".repeat(32)).toString("base64")
    const ctx = { keyHexOrBase64: keyBase64, keyEnvName: "TEST_KEY" }

    const encrypted = encryptValue("hello", ctx)
    expect(decryptValue(encrypted, ctx)).toBe("hello")
  })

  it("falha com chave errada (auth tag mismatch)", () => {
    const ctx1 = { keyHexOrBase64: "a".repeat(64), keyEnvName: "TEST_KEY" }
    const ctx2 = { keyHexOrBase64: "b".repeat(64), keyEnvName: "TEST_KEY" }

    const encrypted = encryptValue("secret", ctx1)
    expect(() => decryptValue(encrypted, ctx2)).toThrow()
  })
})
