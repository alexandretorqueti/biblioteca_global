import { afterEach, describe, expect, it, vi } from "vitest"
import { ConsoleAgentRuntimeDriver } from "../src/runtime/ConsoleAgentRuntimeDriver.js"

describe("ConsoleAgentRuntimeDriver", () => {
  afterEach(() => vi.restoreAllMocks())

  it("remove a sessão pelo endpoint oficial ao encerrar", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, deleted: true }), { status: 200 }),
    )
    const driver = new ConsoleAgentRuntimeDriver({ baseUrl: "http://console.test", token: "test-token" })

    await driver.closeSession({ key: "dev-model-task", agentId: "programador-senior" })

    expect(fetchMock).toHaveBeenCalledWith(
      "http://console.test/api/sessions",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ key: "dev-model-task", agentId: "programador-senior" }),
      }),
    )
  })

  describe("listAgents", () => {
    it("retorna lista de agentes do gateway", async () => {
      const agents = [
        { id: "programador-senior", workspace: "/workspace/senior" },
        { id: "taqui", workspace: "/workspace/taqui" },
      ]
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ agents }), { status: 200 }),
      )
      const driver = new ConsoleAgentRuntimeDriver({ baseUrl: "http://console.test", token: "test-token" })

      const result = await driver.listAgents()

      expect(result).toEqual(agents)
      expect(result).toHaveLength(2)
    })

    it("retorna lista vazia quando gateway não tem agentes", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ agents: [] }), { status: 200 }),
      )
      const driver = new ConsoleAgentRuntimeDriver({ baseUrl: "http://console.test", token: "test-token" })

      const result = await driver.listAgents()

      expect(result).toEqual([])
    })

    it("propaga erro quando gateway retorna 401", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "Invalid token" } }), { status: 401 }),
      )
      const driver = new ConsoleAgentRuntimeDriver({ baseUrl: "http://console.test", token: "bad-token" })

      await expect(driver.listAgents()).rejects.toThrow()
    })

    it("propaga erro de rede", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
      const driver = new ConsoleAgentRuntimeDriver({ baseUrl: "http://console.test", token: "test-token" })

      await expect(driver.listAgents()).rejects.toThrow("ECONNREFUSED")
    })
  })

  it("recupera mensagem integral pelo id, vinculada à sessão e ao agente", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: { role: "assistant", content: "{\"subtarefas\":[]}" } }), { status: 200 }),
    )
    const driver = new ConsoleAgentRuntimeDriver({ baseUrl: "http://console.test", token: "test-token" })

    const content = await driver.readFullAssistantMessage({ key: "analysis-task-780", agentId: "programador-senior" }, "msg-123")

    expect(content).toBe('{"subtarefas":[]}')
    expect(fetchMock).toHaveBeenCalledWith(
      "http://console.test/api/chat/message?sessionKey=analysis-task-780&agentId=programador-senior&messageId=msg-123&maxChars=500000",
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("rejeita recuperação que não retorna mensagem do assistente", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: { role: "user", content: "conteudo" } }), { status: 200 }),
    )
    const driver = new ConsoleAgentRuntimeDriver({ baseUrl: "http://console.test", token: "test-token" })

    await expect(driver.readFullAssistantMessage({ key: "analysis-task-780", agentId: "programador-senior" }, "msg-123"))
      .rejects.toThrow("resposta invalida")
  })
})
