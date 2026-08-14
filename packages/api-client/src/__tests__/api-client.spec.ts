import { beforeEach, describe, expect, it } from "vitest"
import type { EntityRecord, PaginatedResult } from "@biblioteca-global/shared"
import {
  ApiClientError,
  ApiHttpClient,
  AuthClient,
  createDataSource,
  RestEntityClient,
} from "../index"
import type { FetchFn, TokenStore } from "../index"

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

/** Fetch fake programável: responde por fila de respostas. */
class FakeFetch {
  requests: RegistroRequest[] = []
  private respostas: RespostaFake[] = []

  enqueue(...respostas: RespostaFake[]): void {
    this.respostas.push(...respostas)
  }

  handler: FetchFn = async (url, init) => {
    const registro: RegistroRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body !== undefined ? JSON.parse(init.body) : undefined,
    }
    this.requests.push(registro)
    const resposta = this.respostas.shift() ?? { status: 200, body: {} }
    return {
      status: resposta.status,
      json: async () => resposta.body,
    }
  }
}

class MemoriaTokenStore implements TokenStore {
  access: string | null = null
  refresh: string | null = null
  getAccessToken(): string | null {
    return this.access
  }
  getRefreshToken(): string | null {
    return this.refresh
  }
  setAccessToken(token: string | null): void {
    this.access = token
  }
  setRefreshToken(token: string | null): void {
    this.refresh = token
  }
}

describe("ApiHttpClient", () => {
  let fake: FakeFetch
  let tokens: MemoriaTokenStore
  let http: ApiHttpClient

  beforeEach(() => {
    fake = new FakeFetch()
    tokens = new MemoriaTokenStore()
    tokens.access = "access-1"
    tokens.refresh = "refresh-1"
    http = new ApiHttpClient({
      baseUrl: "http://api.local/api",
      tokens,
      fetchImpl: fake.handler,
    })
  })

  it("injeta o access token no header Authorization", async () => {
    fake.enqueue({ status: 200, body: { ok: true } })
    await http.request("GET", "/auth/me")
    expect(fake.requests.at(0)?.headers.Authorization).toBe("Bearer access-1")
    expect(fake.requests.at(0)?.url).toBe("http://api.local/api/auth/me")
  })

  it("modo refresh usa o refresh token", async () => {
    fake.enqueue({ status: 200, body: {} })
    await http.request("POST", "/auth/refresh", { auth: "refresh" })
    expect(fake.requests.at(0)?.headers.Authorization).toBe(
      "Bearer refresh-1",
    )
  })

  it("modo none não envia Authorization (login)", async () => {
    fake.enqueue({ status: 201, body: {} })
    await http.request("POST", "/auth/login", {
      body: { identifier: "x" },
      auth: "none",
    })
    expect(fake.requests.at(0)?.headers.Authorization).toBeUndefined()
  })

  it("monta query string ignorando undefined", async () => {
    fake.enqueue({ status: 200, body: {} })
    await http.request("GET", "/componentes", {
      query: { page: 2, pageSize: 10, search: "grid", vazio: undefined },
    })
    expect(fake.requests.at(0)?.url).toBe(
      "http://api.local/api/componentes?page=2&pageSize=10&search=grid",
    )
  })

  it("mapeia erros do back para ApiClientError", async () => {
    fake.enqueue({
      status: 400,
      body: { code: "VALIDATION_ERROR", message: "Registro inválido" },
    })
    const erro = await http
      .request("POST", "/componentes", { body: { nome: "x" } })
      .catch((e: unknown) => e)
    expect(erro).toBeInstanceOf(ApiClientError)
    expect((erro as ApiClientError).status).toBe(400)
    expect((erro as ApiClientError).code).toBe("VALIDATION_ERROR")
  })

  it("401 → chama recuperação de sessão e repete a chamada uma vez", async () => {
    fake.enqueue(
      { status: 401, body: { code: "UNAUTHORIZED", message: "expirado" } },
      { status: 200, body: { ok: true } },
    )
    let chamadasRecuperacao = 0
    http.setSessionRecovery(async () => {
      chamadasRecuperacao++
      tokens.access = "access-2"
      return true
    })

    const resultado = await http.request<{ ok: boolean }>("GET", "/auth/me")
    expect(resultado.ok).toBe(true)
    expect(chamadasRecuperacao).toBe(1)
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests.at(1)?.headers.Authorization).toBe("Bearer access-2")
  })

  it("401 com recuperação falha → propaga ApiClientError 401", async () => {
    fake.enqueue({
      status: 401,
      body: { code: "UNAUTHORIZED", message: "expirado" },
    })
    http.setSessionRecovery(async () => false)
    await expect(http.request("GET", "/auth/me")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    })
    expect(fake.requests).toHaveLength(1)
  })

  it("401 em rota de refresh não tenta recuperação", async () => {
    fake.enqueue({
      status: 401,
      body: { code: "UNAUTHORIZED", message: "refresh inválido" },
    })
    let recuperou = false
    http.setSessionRecovery(async () => {
      recuperou = true
      return true
    })
    await expect(
      http.request("POST", "/auth/refresh", { auth: "refresh" }),
    ).rejects.toBeInstanceOf(ApiClientError)
    expect(recuperou).toBe(false)
  })
})

describe("regra de ouro: projetoId nunca sai do cliente", () => {
  let fake: FakeFetch
  let http: ApiHttpClient

  beforeEach(() => {
    fake = new FakeFetch()
    const tokens = new MemoriaTokenStore()
    tokens.access = "access-1"
    http = new ApiHttpClient({
      baseUrl: "http://api.local/api",
      tokens,
      fetchImpl: fake.handler,
    })
  })

  it("body com projetoId → erro antes de qualquer requisição", async () => {
    await expect(
      http.request("POST", "/usuarios", {
        body: { nome: "X", projetoId: 2 },
      }),
    ).rejects.toThrow(/projetoId jamais deve ser enviado/)
    expect(fake.requests).toHaveLength(0)
  })
})

describe("AuthClient", () => {
  let fake: FakeFetch
  let auth: AuthClient
  let tokens: MemoriaTokenStore

  beforeEach(() => {
    fake = new FakeFetch()
    tokens = new MemoriaTokenStore()
    const http = new ApiHttpClient({
      baseUrl: "http://api.local/api",
      tokens,
      fetchImpl: fake.handler,
    })
    auth = new AuthClient(http)
  })

  it("cobre todas as rotas /auth com o modo de auth correto", async () => {
    fake.enqueue(
      { status: 201, body: { refreshToken: "r1", usuario: {}, projetos: [] } },
      { status: 201, body: { accessToken: "a1", projeto: {} } },
      { status: 201, body: { refreshToken: "r2", projetos: [] } },
      { status: 201, body: { ok: true } },
      { status: 201, body: { ok: true } },
      { status: 200, body: { usuario: {}, projeto: null, perfil: null } },
    )

    await auth.login({
      identifier: "alexandre",
      password: "senha",
      identifierType: "username",
    })
    tokens.refresh = "r1"
    await auth.selectProject({ projetoId: 1 })
    await auth.refresh()
    await auth.logout()
    tokens.access = "a1"
    await auth.changePassword({ senhaAtual: "a", novaSenha: "nova-senha-1" })
    await auth.me()

    const chamadas = fake.requests.map((r) => `${r.method} ${r.url}`)
    expect(chamadas).toEqual([
      "POST http://api.local/api/auth/login",
      "POST http://api.local/api/auth/select-project",
      "POST http://api.local/api/auth/refresh",
      "POST http://api.local/api/auth/logout",
      "POST http://api.local/api/auth/change-password",
      "GET http://api.local/api/auth/me",
    ])
    // login sem token; select/refresh/logout com refresh token.
    expect(fake.requests.at(0)?.headers.Authorization).toBeUndefined()
    expect(fake.requests.at(1)?.headers.Authorization).toBe("Bearer r1")
    expect(fake.requests.at(4)?.headers.Authorization).toBe("Bearer a1")
  })

  it("select-project é a única exceção legítima: envia projetoId (PoC §5.1)", async () => {
    fake.enqueue({ status: 201, body: { accessToken: "a1", projeto: {} } })
    await auth.selectProject({ projetoId: 2 })
    expect(fake.requests.at(0)?.body).toEqual({ projetoId: 2 })
  })
})

describe("RestEntityClient + createDataSource", () => {
  let fake: FakeFetch
  let client: RestEntityClient<EntityRecord>

  beforeEach(() => {
    fake = new FakeFetch()
    const tokens = new MemoriaTokenStore()
    tokens.access = "access-1"
    const http = new ApiHttpClient({
      baseUrl: "http://api.local/api",
      tokens,
      fetchImpl: fake.handler,
    })
    client = new RestEntityClient<EntityRecord>(http, "componentes")
  })

  it("CRUD completo: métodos, caminhos e filtros", async () => {
    const pagina: PaginatedResult<EntityRecord> = {
      items: [{ id: 1, nome: "Grid" }],
      total: 1,
      page: 1,
      pageSize: 20,
    }
    fake.enqueue(
      { status: 200, body: pagina },
      { status: 200, body: { id: 1, nome: "Grid" } },
      { status: 201, body: { id: 2, nome: "Form" } },
      { status: 200, body: { id: 1, nome: "JsonGrid" } },
      { status: 200, body: { ok: true } },
    )

    const listagem = await client.list({
      page: 1,
      pageSize: 20,
      filters: { categoria: "layout" },
    })
    expect(listagem.items).toHaveLength(1)
    expect(fake.requests.at(0)?.url).toBe(
      "http://api.local/api/componentes?page=1&pageSize=20&categoria=layout",
    )

    await client.get(1)
    await client.create({ nome: "Form", categoria: "form" })
    await client.update(1, { nome: "JsonGrid" })
    await client.remove(1)

    const chamadas = fake.requests.map((r) => `${r.method} ${r.url}`)
    expect(chamadas.slice(1)).toEqual([
      "GET http://api.local/api/componentes/1",
      "POST http://api.local/api/componentes",
      "PUT http://api.local/api/componentes/1",
      "DELETE http://api.local/api/componentes/1",
    ])
    expect(fake.requests.at(2)?.body).toEqual({
      nome: "Form",
      categoria: "form",
    })
  })

  it("createDataSource implementa o contrato da tela Cadastro", async () => {
    fake.enqueue(
      {
        status: 200,
        body: {
          items: [
            { id: 1, nome: "Grid" },
            { id: 2, nome: "Form" },
          ],
          total: 2,
          page: 1,
          pageSize: 500,
        },
      },
      { status: 200, body: { id: 1, nome: "Grid", ativo: false } },
    )

    const tokens = new MemoriaTokenStore()
    tokens.access = "access-1"
    const http = new ApiHttpClient({
      baseUrl: "http://api.local/api",
      tokens,
      fetchImpl: fake.handler,
    })
    const dataSource = createDataSource(http, "componentes")

    const itens = await dataSource.list()
    expect(itens).toHaveLength(2)
    const primeiro = itens.at(0)
    if (!primeiro) throw new Error("lista vazia no teste")
    expect(dataSource.getRowId(primeiro)).toBe(1)

    const atualizado = await dataSource.update(primeiro, { ativo: false })
    expect(atualizado).toEqual({ id: 1, nome: "Grid", ativo: false })
    expect(fake.requests.at(1)?.method).toBe("PUT")
  })
})
