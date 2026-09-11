import { describe, expect, it } from "vitest"
import {
  CODIGO_ERRO_VALIDACAO,
  erroReportavel,
  montarEndpointCanonico,
} from "../index.js"

describe("erroReportavel — política central de classificação", () => {
  const tabela: Array<{
    descricao: string
    entrada: Parameters<typeof erroReportavel>[0]
    reportavel: boolean
  }> = [
    { descricao: "404 não reportável", entrada: { status: 404 }, reportavel: false },
    { descricao: "401 não reportável", entrada: { status: 401 }, reportavel: false },
    { descricao: "403 não reportável", entrada: { status: 403 }, reportavel: false },
    { descricao: "409 não reportável", entrada: { status: 409 }, reportavel: false },
    { descricao: "429 não reportável", entrada: { status: 429 }, reportavel: false },
    {
      descricao: "400 de validação não reportável",
      entrada: { status: 400, code: CODIGO_ERRO_VALIDACAO },
      reportavel: false,
    },
    {
      descricao: "422 de validação não reportável",
      entrada: { status: 422, code: CODIGO_ERRO_VALIDACAO },
      reportavel: false,
    },
    { descricao: "500 reportável", entrada: { status: 500 }, reportavel: true },
    { descricao: "503 reportável", entrada: { status: 503 }, reportavel: true },
    {
      descricao: "4xx não mapeado reportável",
      entrada: { status: 418 },
      reportavel: true,
    },
    {
      descricao: "400 sem marcador de validação reportável (pode ser defeito real)",
      entrada: { status: 400, code: "BAD_REQUEST" },
      reportavel: true,
    },
    {
      descricao: "400 sem code algum reportável",
      entrada: { status: 400 },
      reportavel: true,
    },
    {
      descricao: "falha sem resposta HTTP reportável",
      entrada: { status: null },
      reportavel: true,
    },
    { descricao: "status ausente reportável", entrada: {}, reportavel: true },
  ]

  it.each(tabela)("$descricao", ({ entrada, reportavel }) => {
    const resultado = erroReportavel(entrada)

    expect(resultado.reportavel).toBe(reportavel)
    expect(resultado.motivo.length).toBeGreaterThan(0)
  })

  it("distingue o 400 ambíguo do CRUD pela presença do marcador de validação", () => {
    const validacao = erroReportavel({
      status: 400,
      code: CODIGO_ERRO_VALIDACAO,
      origem: { rota: "/clientes", tela: "Cadastro de clientes" },
    })
    const defeito = erroReportavel({
      status: 400,
      code: "BAD_REQUEST",
      origem: { rota: "/clientes", tela: "Cadastro de clientes" },
    })

    expect(validacao.reportavel).toBe(false)
    expect(validacao.motivo).toContain("Validação da entrada do usuário")
    expect(validacao.motivo).toContain("/clientes")
    expect(defeito.reportavel).toBe(true)
    expect(defeito.motivo).toContain("defeito real")
  })
})

describe("montarEndpointCanonico — chave canônica de endpoint", () => {
  it("normaliza id numérico para :id", () => {
    expect(
      montarEndpointCanonico({ method: "GET", path: "/api/taqui/clientes/12" }),
    ).toBe("GET /api/taqui/clientes/:id")
  })

  it("normaliza id composto e uuid", () => {
    expect(
      montarEndpointCanonico({
        method: "put",
        path: "/api/taqui/clientes/12/enderecos/34",
      }),
    ).toBe("PUT /api/taqui/clientes/:id/enderecos/:id")
    expect(
      montarEndpointCanonico({
        method: "GET",
        path: "/api/taqui/clientes/3f1c9b7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
      }),
    ).toBe("GET /api/taqui/clientes/:id")
  })

  it("remove query string e hash", () => {
    expect(
      montarEndpointCanonico({
        method: "GET",
        path: "/api/taqui/clientes?busca=maria&page=2#topo",
      }),
    ).toBe("GET /api/taqui/clientes")
  })

  it("mantém um único prefixo /api quando o caminho e o slug já o trazem", () => {
    expect(
      montarEndpointCanonico({
        method: "POST",
        path: "/api/taqui/clientes",
        slug: "taqui",
      }),
    ).toBe("POST /api/taqui/clientes")
  })

  it("preenche o prefixo /api e o slug quando o caminho relativo é informado", () => {
    expect(
      montarEndpointCanonico({ method: "get", path: "clientes/12", slug: "/taqui/" }),
    ).toBe("GET /api/taqui/clientes/:id")
  })

  it("não insere o slug nos resources servidos sem slug na URL", () => {
    expect(
      montarEndpointCanonico({ method: "POST", path: "/api/usuarios", slug: "taqui" }),
    ).toBe("POST /api/usuarios")
    expect(
      montarEndpointCanonico({ method: "GET", path: "/api/projetos/7", slug: "taqui" }),
    ).toBe("GET /api/projetos/:id")
  })

  it("ignora barra final e método vazio", () => {
    expect(
      montarEndpointCanonico({ method: "", path: "/api/taqui/clientes/" }),
    ).toBe("HTTP /api/taqui/clientes")
    expect(montarEndpointCanonico({ method: "GET", path: "" })).toBe("GET /api")
  })
})
