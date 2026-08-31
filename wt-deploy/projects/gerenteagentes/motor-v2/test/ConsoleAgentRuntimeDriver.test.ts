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
})
