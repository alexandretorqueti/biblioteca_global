import { beforeEach, describe, expect, it } from "vitest"
import { ApiHttpClient, createAgentChatClient } from "../index"
import type { FetchFn, TokenStore } from "../index"

class Tokens implements TokenStore {
  getAccessToken(): string | null { return null }
  getRefreshToken(): string | null { return null }
  setAccessToken(): void {}
  setRefreshToken(): void {}
}

class FakeFetch {
  requests: Array<{ method: string; url: string; body?: unknown }> = []
  responses: Array<{ status: number; body: unknown }> = []

  handler: FetchFn = async (url, init) => {
    this.requests.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined })
    const response = this.responses.shift() ?? { status: 200, body: {} }
    return { status: response.status, json: async () => response.body }
  }
}

describe("createAgentChatClient", () => {
  let fake: FakeFetch

  beforeEach(() => { fake = new FakeFetch() })

  function create() {
    return createAgentChatClient({
      http: new ApiHttpClient({ baseUrl: "http://api.local/api", tokens: new Tokens(), fetchImpl: fake.handler }),
      agentId: "isa",
      visitorKey: "visitor-1",
      endpoints: {
        sessionPath: "/session",
        sendPath: "/chat/send",
        historyPath: (chatId) => `/chat/${chatId}/history`,
        visitPath: "/site-visit",
        buildSessionBody: ({ visitorKey }) => ({ chatKey: visitorKey }),
        buildSendBody: ({ chatId, text, attachments }) => ({ chatId, text, attachments }),
        historyMetadata: (data) => ({ project: data.project, onboarding: data.onboarding }),
      },
    })
  }

  it("adapta a sessão e o histórico para as rotas da Isa", async () => {
    fake.responses.push(
      { status: 201, body: { chatId: "chat-1", existing: false } },
      { status: 200, body: { chatId: "chat-1", messages: [{ id: "m1", role: "agent", text: "Olá!" }], project: { name: "Site" }, onboarding: { verified: true } } },
    )
    const client = create()
    await expect(client.startSession()).resolves.toEqual({ chatId: "chat-1", existing: false })
    await expect(client.loadHistory()).resolves.toMatchObject({
      chatId: "chat-1",
      messages: [{ text: "Olá!" }],
      metadata: { project: { name: "Site" }, onboarding: { verified: true } },
    })
    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST http://api.local/api/session",
      "GET http://api.local/api/chat/chat-1/history",
    ])
    expect(fake.requests[0]?.body).toEqual({ chatKey: "visitor-1" })
  })

  it("não cria sessão nem consulta histórico ao carregar a página", async () => {
    const client = create()

    await expect(client.loadHistory()).resolves.toEqual({ chatId: "visitor-1", messages: [] })
    expect(fake.requests).toHaveLength(0)
  })

  it("cria uma única sessão no primeiro contato e reutiliza-a", async () => {
    fake.responses.push(
      { status: 200, body: { chatId: "chat-1", existing: false } },
      { status: 200, body: { ok: true, messageId: "message-1" } },
      { status: 200, body: { ok: true, messageId: "message-2" } },
    )
    const client = create()

    await expect(client.sendMessage("Primeiro contato")).resolves.toMatchObject({ ok: true })
    await expect(client.sendMessage("Segundo contato")).resolves.toMatchObject({ ok: true })

    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST http://api.local/api/session",
      "POST http://api.local/api/chat/send",
      "POST http://api.local/api/chat/send",
    ])
    expect(fake.requests[1]?.body).toMatchObject({ chatId: "chat-1", text: "Primeiro contato" })
    expect(fake.requests[2]?.body).toMatchObject({ chatId: "chat-1", text: "Segundo contato" })
  })

  it("enfileira falha de rede e envia a fila quando o backend volta", async () => {
    fake.responses.push({ status: 503, body: { code: "UNAVAILABLE" } }, { status: 201, body: { ok: true } })
    const client = create()
    await expect(client.sendMessage("Oi")).resolves.toEqual({ ok: false, reason: "http_error", retryable: true })
    expect(client.outbox).toHaveLength(0)

    fake.responses.push({ status: 200, body: { ok: true } })
    await expect(client.flushOutbox()).resolves.toBe(0)
  })

  it("converte erro de transporte em offline e preserva a mensagem", async () => {
    const offline: FetchFn = async () => { throw new Error("network down") }
    const client = createAgentChatClient({
      http: new ApiHttpClient({ baseUrl: "http://api.local/api", tokens: new Tokens(), fetchImpl: offline }),
      agentId: "isa",
      visitorKey: "visitor-1",
    })
    await expect(client.sendMessage("Preciso de ajuda")).resolves.toEqual({ ok: false, reason: "offline", retryable: true })
    expect(client.outbox).toHaveLength(1)
  })
})
