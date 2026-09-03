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
})
