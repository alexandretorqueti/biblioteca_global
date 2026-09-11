import { describe, expect, it } from "vitest"
import {
  errorReportResultSchema,
  errorReportRequestSchema,
  tituloTarefaErro,
} from "../index.js"

/** Payload completo e válido — cobre todos os dados exigidos no relato. */
const relatoValido = {
  endpoint: "POST /api/taqui/clientes",
  url: "/api/taqui/clientes",
  query: { busca: "maria" },
  requestBody: { nome: "Maria", email: "maria@exemplo.com" },
  responseStatus: 500,
  responseBody: { code: "INTERNAL_ERROR", message: "Falha inesperada" },
  error: {
    name: "ApiHttpError",
    message: "Falha inesperada",
    code: "INTERNAL_ERROR",
    details: { campo: "nome" },
  },
  usuario: { id: 12, nome: "Alexandre", login: "alexandre" },
  origem: {
    rota: "/clientes",
    tela: "Cadastro de clientes",
    funcionalidade: "cadastro",
  },
  ocorridoEm: "2026-09-11T21:35:48.032Z",
}

describe("contrato do relato de erro", () => {
  it("aceita um relato completo com usuário, tela, origem e transporte", () => {
    const result = errorReportRequestSchema.safeParse(relatoValido)

    expect(result.success).toBe(true)
  })

  it("aceita o relato mínimo (opcionais ausentes) e falha de rede sem resposta HTTP", () => {
    const minimo = errorReportRequestSchema.safeParse({
      endpoint: "GET /api/taqui/clientes",
      url: "/api/taqui/clientes",
      responseStatus: null,
      usuario: { id: 12 },
      origem: { rota: "/clientes" },
      ocorridoEm: "2026-09-11T21:35:48.032Z",
    })

    expect(minimo.success).toBe(true)
  })

  it("rejeita relato com campo extra (payload fechado)", () => {
    const extra = errorReportRequestSchema.safeParse({
      ...relatoValido,
      projetoId: 1,
    })

    expect(extra.success).toBe(false)
  })

  it("rejeita relato com campo obrigatório ausente", () => {
    for (const campo of [
      "endpoint",
      "url",
      "responseStatus",
      "usuario",
      "origem",
      "ocorridoEm",
    ]) {
      const semCampo: Record<string, unknown> = { ...relatoValido }
      delete semCampo[campo]
      expect(errorReportRequestSchema.safeParse(semCampo).success).toBe(false)
    }
  })

  it("rejeita sub-objetos com campo extra ou obrigatório ausente", () => {
    expect(
      errorReportRequestSchema.safeParse({
        ...relatoValido,
        usuario: { id: 12, senha: "segredo" },
      }).success,
    ).toBe(false)
    expect(
      errorReportRequestSchema.safeParse({
        ...relatoValido,
        usuario: { nome: "Alexandre" },
      }).success,
    ).toBe(false)
    expect(
      errorReportRequestSchema.safeParse({
        ...relatoValido,
        origem: { tela: "Cadastro" },
      }).success,
    ).toBe(false)
  })

  it("rejeita ocorridoEm fora do formato ISO-8601", () => {
    expect(
      errorReportRequestSchema.safeParse({
        ...relatoValido,
        ocorridoEm: "2026-09-11 21:35:48",
      }).success,
    ).toBe(false)
  })

  it("monta o título canônico da tarefa a partir da chave do endpoint", () => {
    expect(tituloTarefaErro("GET /api/taqui/clientes/:id")).toBe(
      "Erro de API: GET /api/taqui/clientes/:id",
    )
    // Mesma entrada, mesmo título — é o que a deduplicação compara.
    expect(tituloTarefaErro("GET /api/taqui/clientes/:id")).toBe(
      tituloTarefaErro("GET /api/taqui/clientes/:id"),
    )
    expect(tituloTarefaErro("   ")).toBe("Erro de API: HTTP /api")
  })

  it("trunca o título no limite da coluna sem perder o prefixo", () => {
    const longo = `GET /api/taqui/${"segmento/".repeat(40)}:id`
    const titulo = tituloTarefaErro(longo)

    expect(titulo.length).toBeLessThanOrEqual(200)
    expect(titulo.startsWith("Erro de API: ")).toBe(true)
  })

  it("descreve o resultado do relato com e sem tarefa criada", () => {
    expect(
      errorReportResultSchema.safeParse({ registrada: true, tarefaId: 815 })
        .success,
    ).toBe(true)
    expect(
      errorReportResultSchema.safeParse({
        registrada: false,
        motivo: "Tarefa do mesmo endpoint ainda ativa",
      }).success,
    ).toBe(true)
    expect(
      errorReportResultSchema.safeParse({ registrada: true, extra: 1 }).success,
    ).toBe(false)
  })
})
