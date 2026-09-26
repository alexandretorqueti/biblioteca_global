import { beforeEach, describe, expect, it } from "vitest"
import { ExternalApiError, ExternalApiClient } from "../external-client"
import type { FetchFn } from "../index"

interface RegistroRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

interface RespostaFake {
  status: number
  body?: unknown
}

class FakeFetch {
  requests: RegistroRequest[] = []
  private respostas: RespostaFake[] = []

  enqueue(...respostas: RespostaFake[]): void {
    this.respostas.push(...respostas)
  }

  handler: FetchFn = async (url, init) => {
    this.requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body !== undefined ? JSON.parse(init.body) : undefined,
    })
    const resposta = this.respostas.shift() ?? { status: 200, body: {} }
    return {
      status: resposta.status,
      json: async () => resposta.body,
    }
  }
}

describe("ExternalApiClient — montagem de URL", () => {
  it("interpola :id no path template", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 200, body: { id: 5, nome: "Z" } })
    const client = new ExternalApiClient<{ id: number; nome: string }>({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.get("/projetos/:id", { id: 5 })
    expect(fake.requests.at(0)?.url).toBe("http://ext.local/api/projetos/5")
  })

  it("interpola múltiplos parâmetros", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 200, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.get("/projetos/:projetoId/usuarios/:userId", { projetoId: 3, userId: 7 })
    expect(fake.requests.at(0)?.url).toBe("http://ext.local/api/projetos/3/usuarios/7")
  })

  it("falta parâmetro obrigatório → lança erro sem enviar requisição", async () => {
    const fake = new FakeFetch()
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await expect(
      client.get("/projetos/:id", {}),
    ).rejects.toThrow(/parâmetro obrigatório/)
    expect(fake.requests).toHaveLength(0)
  })

  it("monta query string", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 200, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.get("/projetos/:id/dados", { id: 1 }, { query: { page: 2, search: "x" } })
    expect(fake.requests.at(0)?.url).toBe("http://ext.local/api/projetos/1/dados?page=2&search=x")
  })

  it("baseUrl + path sem :id funciona sem params", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 200, body: [] })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.get("/projetos")
    expect(fake.requests.at(0)?.url).toBe("http://ext.local/api/projetos")
  })
})

describe("ExternalApiClient — token bearer", () => {
  it("envia Authorization quando bearerToken está presente", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 200, body: {} })
    const client = new ExternalApiClient({
      baseUrl: "http://ext.local/api",
      bearerToken: "token-servico-xyz",
      fetchImpl: fake.handler,
    })
    await client.get("/dados")
    expect(fake.requests.at(0)?.headers.Authorization).toBe("Bearer token-servico-xyz")
  })

  it("não envia Authorization quando bearerToken está ausente", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 200, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.get("/dados")
    expect(fake.requests.at(0)?.headers.Authorization).toBeUndefined()
  })
})

describe("ExternalApiClient — verbos HTTP", () => {
  let fake: FakeFetch

  beforeEach(() => {
    fake = new FakeFetch()
  })

  it("POST monta URL, body e método", async () => {
    fake.enqueue({ status: 201, body: { criado: true } })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.post("/projetos/:id/filas", { id: 4 }, { nome: "Fila A" })
    expect(fake.requests.at(0)?.method).toBe("POST")
    expect(fake.requests.at(0)?.url).toBe("http://ext.local/api/projetos/4/filas")
    expect(fake.requests.at(0)?.body).toEqual({ nome: "Fila A" })
  })

  it("PUT monta URL e body", async () => {
    fake.enqueue({ status: 200, body: { atualizado: true } })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.put("/projetos/:id", { id: 4 }, { nome: "Fila B" })
    expect(fake.requests.at(0)?.method).toBe("PUT")
    expect(fake.requests.at(0)?.body).toEqual({ nome: "Fila B" })
  })

  it("DELETE envia método correto sem body", async () => {
    fake.enqueue({ status: 204, body: undefined })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.delete("/projetos/:id/filas/:filaId", { id: 4, filaId: 9 })
    expect(fake.requests.at(0)?.method).toBe("DELETE")
    expect(fake.requests.at(0)?.body).toBeUndefined()
  })

  it("DELETE devolve T tipado", async () => {
    fake.enqueue({ status: 200, body: { deletado: true } })
    const client = new ExternalApiClient<{ deletado: boolean }>({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const res = await client.delete("/projetos/:id", { id: 4 })
    expect(res.deletado).toBe(true)
  })

  it("DELETE sem params interpola path template corretamente", async () => {
    fake.enqueue({ status: 204, body: undefined })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.delete("/projetos/:projetoId/subtarefas/:subtaskId", { projetoId: 2, subtaskId: 7 })
    expect(fake.requests.at(0)?.url).toBe("http://ext.local/api/projetos/2/subtarefas/7")
  })
})

describe("ExternalApiClient — erros mapeados", () => {
  let fake: FakeFetch

  beforeEach(() => {
    fake = new FakeFetch()
  })

  it("400 → ExternalApiError BAD_REQUEST", async () => {
    fake.enqueue({ status: 400, body: { code: "VALIDATION_ERROR", message: "Inválido" } })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const erro = await client.get("/projetos/1").catch((e) => e)
    expect(erro).toBeInstanceOf(ExternalApiError)
    expect((erro as ExternalApiError).status).toBe(400)
    expect((erro as ExternalApiError).code).toBe("VALIDATION_ERROR")
  })

  it("404 → ExternalApiError NOT_FOUND", async () => {
    fake.enqueue({ status: 404, body: { code: "NOT_FOUND", message: "Não encontrado" } })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const erro = await client.get("/projetos/999").catch((e) => e)
    expect(erro).toBeInstanceOf(ExternalApiError)
    expect((erro as ExternalApiError).code).toBe("NOT_FOUND")
  })

  it("401 → ExternalApiError UNAUTHORIZED", async () => {
    fake.enqueue({ status: 401, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const erro = await client.get("/projetos").catch((e) => e)
    expect(erro).toBeInstanceOf(ExternalApiError)
    expect((erro as ExternalApiError).code).toBe("UNAUTHORIZED")
  })

  it("422 → ExternalApiError UNPROCESSABLE_ENTITY", async () => {
    fake.enqueue({ status: 422, body: { code: "UNPROCESSABLE_ENTITY" } })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const erro = await client.get("/x").catch((e) => e)
    expect((erro as ExternalApiError).code).toBe("UNPROCESSABLE_ENTITY")
  })

  it("429 → ExternalApiError TOO_MANY_REQUESTS", async () => {
    fake.enqueue({ status: 429, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const erro = await client.get("/x").catch((e) => e)
    expect((erro as ExternalApiError).code).toBe("TOO_MANY_REQUESTS")
  })

  it("500 → ExternalApiError INTERNAL_SERVER_ERROR", async () => {
    fake.enqueue({ status: 500, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const erro = await client.get("/x").catch((e) => e)
    expect((erro as ExternalApiError).code).toBe("INTERNAL_SERVER_ERROR")
  })

  it("código não listado → HTTP_<status>", async () => {
    fake.enqueue({ status: 504, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const erro = await client.get("/x").catch((e) => e)
    expect((erro as ExternalApiError).code).toBe("HTTP_504")
  })

  it("corpo JSON com code/message/details é preservado", async () => {
    fake.enqueue({
      status: 409,
      body: { code: "CONFLICT", message: "Já existe", details: ["campo duplicado"] },
    })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    const erro = await client.get("/x").catch((e) => e)
    expect((erro as ExternalApiError).status).toBe(409)
    expect((erro as ExternalApiError).message).toBe("Já existe")
    expect((erro as ExternalApiError).details).toEqual(["campo duplicado"])
  })

  it("corpo inválido → fallback genérico", async () => {
    const fake2 = new FakeFetch()
    fake2.enqueue({ status: 503, body: null })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake2.handler })
    const erro = await client.get("/x").catch((e) => e)
    expect((erro as ExternalApiError).status).toBe(503)
    expect((erro as ExternalApiError).code).toBe("SERVICE_UNAVAILABLE")
  })
})

describe("ExternalApiClient — headers extras", () => {
  it("headers personalizados são incluídos", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 200, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.get("/x", undefined, { headers: { "X-Customo": "valor" } })
    expect(fake.requests.at(0)?.headers["X-Customo"]).toBe("valor")
  })

  it("POST sem body não envia Content-Type", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 201, body: {} })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.post("/projetos/:id/filas", { id: 4 }, undefined)
    expect(fake.requests.at(0)?.headers["Content-Type"]).toBeUndefined()
  })

  it("DELETE sem body não envia Content-Type", async () => {
    const fake = new FakeFetch()
    fake.enqueue({ status: 204, body: undefined })
    const client = new ExternalApiClient({ baseUrl: "http://ext.local/api", fetchImpl: fake.handler })
    await client.delete("/projetos/:id", { id: 1 })
    expect(fake.requests.at(0)?.headers["Content-Type"]).toBeUndefined()
  })
})
