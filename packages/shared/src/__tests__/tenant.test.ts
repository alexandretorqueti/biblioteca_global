import { describe, expect, it } from "vitest"
import { normalizeTenantChatConfig, tenantChatConfigSchema } from "../tenant"

describe("contrato público do tenant", () => {
  it("preenche defaults para config ausente", () => {
    const config = normalizeTenantChatConfig({}, "  Minha Isa  ")
    expect(config.nome).toBe("Minha Isa")
    expect(config.idiomas).toEqual(["pt-BR"])
    expect(config.anexos).toEqual({ permitido: false, tipos: [], maxMb: 10 })
    expect(config.canais).toEqual({ web: true, whatsapp: false })
  })

  it("remove campos internos e não os expõe na projeção", () => {
    const config = normalizeTenantChatConfig(
      { prompt: "segredo", personaRef: "internal", segredosRef: "vault/x", contatos: { email: "interno" } },
      "Isa",
    )
    expect(config).not.toHaveProperty("prompt")
    expect(config).not.toHaveProperty("personaRef")
    expect(config).not.toHaveProperty("segredosRef")
    expect(config).not.toHaveProperty("contatos")
    expect(() => tenantChatConfigSchema.parse({ ...config, prompt: "não pode" })).toThrow()
  })
})
