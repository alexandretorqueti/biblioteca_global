import { describe, expect, it } from "vitest"
import { transbordoConfigSchema } from "../transbordo"

const valido = {
  ativo: true,
  destino: { tipo: "whatsapp", valor: "+5511999999999", nomeAtendente: "Ana" },
  horario: { diasSemana: [1, 2, 3, 4, 5], inicio: "08:00", fim: "18:00", timezone: "America/Sao_Paulo" },
}

describe("transbordoConfigSchema", () => {
  it("aceita configuração estruturalmente válida", () => {
    expect(transbordoConfigSchema.safeParse(valido).success).toBe(true)
  })

  it.each([
    { tipo: "sms", valor: "+5511999999999" },
    { tipo: "whatsapp", valor: "telefone inválido" },
    { tipo: "email", valor: "email inválido" },
  ])("rejeita destino inválido ($tipo)", (destino) => {
    expect(transbordoConfigSchema.safeParse({ ...valido, destino: { ...destino, nomeAtendente: "Ana" } }).success).toBe(false)
  })

  it("rejeita horário fora do formato", () => {
    expect(transbordoConfigSchema.safeParse({ ...valido, horario: { ...valido.horario, inicio: "8h" } }).success).toBe(false)
  })
})
