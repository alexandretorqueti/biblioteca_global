import { describe, expect, it } from "vitest"
import {
  ActionExecutor,
  ApiClientError,
  ApiHttpClient,
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
  getAccessToken(): string | null { return this.access }
  getRefreshToken(): string | null { return this.refresh }
  setAccessToken(token: string | null): void { this.access = token }
  setRefreshToken(token: string | null): void { this.refresh = token }
}

describe("ActionExecutor", () => {
  let fake: FakeFetch
  let tokens: MemoriaTokenStore
  let http: ApiHttpClient
  let executor: ActionExecutor

  function criar() {
    fake = new FakeFetch()
    tokens = new MemoriaTokenStore()
    tokens.access = "access-1"
    http = new ApiHttpClient({
      baseUrl: "http://api.local/api",
      tokens,
      fetchImpl: fake.handler,
    })
    executor = new ActionExecutor(http, "tarefa")
  }

  it("POST → dispara POST para /resource/action-name", async () => {
    criar()
    fake.enqueue({
      status: 200,
      body: { code: "OK", message: "executada" },
    })
    const resultado = await executor.post("executar")
    expect(resultado.code).toBe("OK")
    expect(resultado.message).toBe("executada")
    expect(fake.requests.at(0)?.method).toBe("POST")
    expect(fake.requests.at(0)?.url).toBe("http://api.local/api/tarefa/executar")
  })

  it("PUT → dispara PUT para /resource/action-name", async () => {
    criar()
    fake.enqueue({ status: 200, body: { code: "OK", message: "atualizada" } })
    await executor.put("aprovar")
    expect(fake.requests.at(0)?.method).toBe("PUT")
    expect(fake.requests.at(0)?.url).toBe("http://api.local/api/tarefa/aprovar")
  })

  it("DELETE → dispara DELETE para /resource/action-name", async () => {
    criar()
    fake.enqueue({ status: 200, body: { code: "OK", message: "desativada" } })
    await executor.delete("desativar")
    expect(fake.requests.at(0)?.method).toBe("DELETE")
    expect(fake.requests.at(0)?.url).toBe("http://api.local/api/tarefa/desativar")
  })

  it("envia payload no body quando fornecido", async () => {
    criar()
    fake.enqueue({ status: 200, body: { code: "OK", message: "ok" } })
    await executor.post("executar", { tarefaId: 5, parametro: "valor" })
    expect(fake.requests.at(0)?.body).toEqual({ tarefaId: 5, parametro: "valor" })
  })

  it("envia headers adicionais", async () => {
    criar()
    fake.enqueue({ status: 200, body: { code: "OK", message: "ok" } })
    await executor.post("executar", null, {
      headers: { "X-Servico": "worker-1" },
    })
    expect(fake.requests.at(0)?.headers["X-Servico"]).toBe("worker-1")
  })

  it("monta query string quando fornecida", async () => {
    criar()
    fake.enqueue({ status: 200, body: { code: "OK", message: "ok" } })
    await executor.post("executar", null, {
      query: { versao: 2, ignorar: undefined },
    })
    expect(fake.requests.at(0)?.url).toBe(
      "http://api.local/api/tarefa/executar?versao=2",
    )
  })

  it("propaga erro HTTP tipado do back (400)", async () => {
    criar()
    fake.enqueue({
      status: 400,
      body: { code: "VALIDATION_ERROR", message: "Campo inválido" },
    })
    const erro = await executor
      .post("executar", { campo: "invalido" })
      .catch((e) => e)
    expect(erro).toBeInstanceOf(ApiClientError)
    expect((erro as ApiClientError).status).toBe(400)
    expect((erro as ApiClientError).code).toBe("VALIDATION_ERROR")
    expect((erro as ApiClientError).message).toBe("Campo inválido")
  })

  it("propaga erro HTTP tipado do back (404)", async () => {
    criar()
    fake.enqueue({
      status: 404,
      body: { code: "NOT_FOUND", message: "Ação não existe" },
    })
    const erro = await executor.post("inexistente").catch((e) => e)
    expect(erro).toBeInstanceOf(ApiClientError)
    expect((erro as ApiClientError).status).toBe(404)
  })

  it("propaga erro HTTP tipado do back (403)", async () => {
    criar()
    fake.enqueue({
      status: 403,
      body: { code: "FORBIDDEN", message: "Sem permissão" },
    })
    const erro = await executor.post("executar").catch((e) => e)
    expect(erro).toBeInstanceOf(ApiClientError)
    expect((erro as ApiClientError).status).toBe(403)
  })

  it("converte payload null/undefined sem Content-Type", async () => {
    criar()
    fake.enqueue({ status: 200, body: { code: "OK", message: "ok" } })
    await executor.post("executar", null)
    // sem corpo → sem Content-Type
    expect(fake.requests.at(0)?.headers["Content-Type"]).toBeUndefined()
    expect(fake.requests.at(0)?.body).toBeUndefined()
  })

  it("retorna data quando o back retorna corpo simples sem code", async () => {
    criar()
    fake.enqueue({ status: 200, body: { resultado: "123 itens processados" } })
    const r = await executor.post("executar")
    expect(r.code).toBe("OK")
    expect(r.message).toBe("")
    expect(r.data).toEqual({ resultado: "123 itens processados" })
  })

  it("injeta access token no Authorization", async () => {
    criar()
    fake.enqueue({ status: 200, body: { code: "OK", message: "ok" } })
    await executor.post("executar")
    expect(fake.requests.at(0)?.headers.Authorization).toBe("Bearer access-1")
  })
})
