import { describe, expect, it } from "vitest"
import { normalizeTenantChatConfig, tenantChatConfigSchema } from "../tenant"
import { isValidBrPhone, normalizeBrPhone, phoneSlug } from "../canais-whatsapp"

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

describe("identidade canônica do WhatsApp", () => {
  it("normaliza telefone BR formatado para dígitos", () => {
    expect(normalizeBrPhone("(11) 99999-8888")).toBe("11999998888")
    expect(normalizeBrPhone("21 3333-4444")).toBe("2133334444")
    expect(phoneSlug("(11) 99999-8888")).toBe("telefone-11999998888")
  })

  it("aceita somente 10 ou 11 dígitos com DDD", () => {
    expect(isValidBrPhone("11999998888")).toBe(true)
    expect(isValidBrPhone("(21) 3333-4444")).toBe(true)
    expect(isValidBrPhone("123")).toBe(false)
    expect(() => normalizeBrPhone("abc")).toThrow()
  })
})
