import { describe, expect, it } from "vitest"
import {
  tenantConfigAdminInputSchema,
  tenantConversaIngestaoSchema,
  tenantConversasFiltrosSchema,
  tenantMetricasSchema,
} from "../painel-tenant"

const data = "2026-11-18T12:00:00.000Z"

describe("contratos do painel do tenant", () => {
  it("aplica limites de paginação e rejeita tamanho fora do limite", () => {
    expect(tenantConversasFiltrosSchema.parse({})).toMatchObject({ pagina: 1, tamanho: 20 })
    expect(tenantConversasFiltrosSchema.safeParse({ tamanho: 101 }).success).toBe(false)
    expect(tenantConversasFiltrosSchema.safeParse({ periodo: { de: data, ate: "2026-11-17T12:00:00.000Z" } }).success).toBe(false)
  })

  it("valida métricas e a cota sem limite", () => {
    const result = tenantMetricasSchema.safeParse({
      conversasNoMes: 12,
      tempoMedioRespostaSegundos: null,
      temasFrequentes: [{ tema: "preço", quantidade: 8 }],
      cota: { planoSlug: "starter", limiteConversasPorMes: null, usado: 12, percentual: 0, estourada: false },
    })
    expect(result.success).toBe(true)
    expect(tenantMetricasSchema.safeParse({
      conversasNoMes: 12,
      tempoMedioRespostaSegundos: null,
      temasFrequentes: Array.from({ length: 6 }, (_, i) => ({ tema: String(i), quantidade: 1 })),
      cota: { planoSlug: "starter", limiteConversasPorMes: null, usado: 12, percentual: 0, estourada: false },
    }).success).toBe(false)
  })

  it("aceita atualização parcial da configuração e mantém retenção privada", () => {
    const result = tenantConfigAdminInputSchema.safeParse({ configJson: { textos: { saudacao: "Oi" } }, retencaoConversasDias: 30 })
    expect(result.success).toBe(true)
    expect(tenantConfigAdminInputSchema.safeParse({ configJson: { paleta: { primaria: "verde" } } }).success).toBe(false)
  })

  it("valida ingestão de conversa com mensagens", () => {
    expect(tenantConversaIngestaoSchema.safeParse({
      externalId: "chat-1", canal: "web", visitanteKey: "visitor-1", status: "ativa",
      mensagens: [{ role: "visitante", texto: "Olá", criadaEm: data }],
    }).success).toBe(true)
    expect(tenantConversaIngestaoSchema.safeParse({ externalId: "chat-1", canal: "web", visitanteKey: "v", status: "ativa", mensagens: [] }).success).toBe(false)
  })
})
