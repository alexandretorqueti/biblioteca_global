// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { decryptCpf, encryptCpf } from "./cpf"

describe("criptografia de CPF", () => {
  it("criptografa e descriptografa com AES-256-GCM", () => {
    vi.stubEnv("CPF_ENCRYPTION_KEY", "a".repeat(64))

    const encrypted = encryptCpf("123.456.789-09")

    expect(encrypted.split(":")).toHaveLength(3)
    expect(encrypted).not.toContain("123.456.789-09")
    expect(decryptCpf(encrypted)).toBe("123.456.789-09")
  })

  it("gera ciphertext diferente para o mesmo CPF", () => {
    vi.stubEnv("CPF_ENCRYPTION_KEY", "b".repeat(64))

    expect(encryptCpf("12345678909")).not.toBe(encryptCpf("12345678909"))
  })

  it("falha sem chave ou com ciphertext inválido", () => {
    vi.stubEnv("CPF_ENCRYPTION_KEY", "")
    expect(() => encryptCpf("12345678909")).toThrow("CPF_ENCRYPTION_KEY")

    vi.stubEnv("CPF_ENCRYPTION_KEY", "c".repeat(64))
    expect(() => decryptCpf("invalido")).toThrow("formato inválido")
  })
})
