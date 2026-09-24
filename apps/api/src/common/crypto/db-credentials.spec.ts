// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { decryptDbPassword, encryptDbPassword } from "./db-credentials"

describe("criptografia de credenciais de banco", () => {
  it("criptografa e descriptografa a senha do banco", () => {
    vi.stubEnv("DB_CREDENTIALS_ENCRYPTION_KEY", "c".repeat(64))

    const encrypted = encryptDbPassword("P@ssw0rd!")

    expect(encrypted.split(":")).toHaveLength(3)
    expect(encrypted).not.toContain("P@ssw0rd!")
    expect(decryptDbPassword(encrypted)).toBe("P@ssw0rd!")
  })

  it("falha quando DB_CREDENTIALS_ENCRYPTION_KEY está ausente", () => {
    vi.stubEnv("DB_CREDENTIALS_ENCRYPTION_KEY", "")
    expect(() => encryptDbPassword("x")).toThrow("DB_CREDENTIALS_ENCRYPTION_KEY")
  })

  it("gera ciphertext diferente para a mesma senha (IV aleatório)", () => {
    vi.stubEnv("DB_CREDENTIALS_ENCRYPTION_KEY", "d".repeat(64))

    expect(encryptDbPassword("same")).not.toBe(encryptDbPassword("same"))
  })
})
