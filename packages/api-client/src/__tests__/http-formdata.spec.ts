// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { ApiClientError } from "../errors"
import { ApiHttpClient } from "../http"
import type { FetchFn, TokenStore } from "../types"

function tokensFake(): TokenStore {
  return {
    getAccessToken: () => "access-1",
    getRefreshToken: () => "refresh-1",
    setAccessToken: () => undefined,
    setRefreshToken: () => undefined,
  }
}

interface ChamadaCapturada {
  url: string
  method: string
  headers: Record<string, string>
  body?: string | FormData
}

function fakeCapturando(resposta: { status: number; body?: unknown } = { status: 200, body: {} }) {
  const chamadas: ChamadaCapturada[] = []
  const handler: FetchFn = async (url, init) => {
    chamadas.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    })
    return { status: resposta.status, json: async () => resposta.body }
  }
  return { chamadas, handler }
}

describe("ApiHttpClient — body FormData (upload multipart)", () => {
  it("passa o FormData cru ao fetch, sem Content-Type manual e sem JSON.stringify", async () => {
    const { chamadas, handler } = fakeCapturando({ status: 201, body: { ok: true } })
    const http = new ApiHttpClient({
      baseUrl: "http://api.test/api",
      tokens: tokensFake(),
      fetchImpl: handler,
    })

    const form = new FormData()
    form.append("dados", JSON.stringify({ nomeNegocio: "Padaria" }))
    form.append(
      "arquivos",
      new File(["conteudo"], "faq.pdf", { type: "application/pdf" }),
      "faq.pdf",
    )

    await http.request("POST", "/vitrine/pedidos", { body: form, auth: "none" })

    expect(chamadas).toHaveLength(1)
    const chamada = chamadas[0]!
    // Mesma instância — o browser define Content-Type com o boundary.
    expect(chamada.body).toBe(form)
    expect(chamada.headers["Content-Type"]).toBeUndefined()
    expect(chamada.url).toBe("http://api.test/api/vitrine/pedidos")
    // auth "none": nenhum Authorization sai do cliente.
    expect(chamada.headers["Authorization"]).toBeUndefined()
  })

  it("mantém o comportamento JSON existente (Content-Type application/json + stringify)", async () => {
    const { chamadas, handler } = fakeCapturando()
    const http = new ApiHttpClient({
      baseUrl: "http://api.test/api",
      tokens: tokensFake(),
      fetchImpl: handler,
    })

    await http.request("POST", "/vitrine/pedidos-json-regressao", {
      body: { plano: "Pro" },
      auth: "none",
    })

    const chamada = chamadas[0]!
    expect(chamada.headers["Content-Type"]).toBe("application/json")
    expect(chamada.body).toBe(JSON.stringify({ plano: "Pro" }))
  })

  it("FormData com auth access injeta o token mas jamais serializa o body", async () => {
    const { chamadas, handler } = fakeCapturando()
    const http = new ApiHttpClient({
      baseUrl: "http://api.test/api",
      tokens: tokensFake(),
      fetchImpl: handler,
    })

    const form = new FormData()
    form.append("dados", "{}")
    await http.request("POST", "/alguma/coisa", { body: form, auth: "access" })

    const chamada = chamadas[0]!
    expect(chamada.body).toBe(form)
    expect(chamada.headers["Content-Type"]).toBeUndefined()
    expect(chamada.headers["Authorization"]).toBe("Bearer access-1")
  })

  it("sem body nenhum, nenhum Content-Type é enviado (GET puro inalterado)", async () => {
    const { chamadas, handler } = fakeCapturando()
    const http = new ApiHttpClient({
      baseUrl: "http://api.test/api",
      tokens: tokensFake(),
      fetchImpl: handler,
    })

    await http.request("GET", "/vitrine/conteudo", { auth: "none" })
    const chamada = chamadas[0]!
    expect(chamada.body).toBeUndefined()
    expect(chamada.headers["Content-Type"]).toBeUndefined()
  })
})

describe("ApiHttpClient — propagação de erro para o chamador", () => {
  it("400 vira ApiClientError com code/message do corpo padronizado do backend", async () => {
    const { handler } = fakeCapturando({
      status: 400,
      body: {
        code: "VALIDATION_ERROR",
        message:
          "Dados do pedido inválidos — telefone: Telefone BR inválido: informe DDD e número",
      },
    })
    const http = new ApiHttpClient({
      baseUrl: "http://api.test/api",
      tokens: tokensFake(),
      fetchImpl: handler,
    })

    const form = new FormData()
    form.append("dados", "{}")
    const erro = await http
      .request("POST", "/vitrine/pedidos", { body: form, auth: "none" })
      .catch((e: unknown) => e)

    expect(erro).toBeInstanceOf(ApiClientError)
    expect(erro).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("telefone"),
    })
  })
})
