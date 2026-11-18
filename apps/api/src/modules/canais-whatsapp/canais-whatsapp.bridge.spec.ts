// @vitest-environment node
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import { CanaisWhatsappBridgeService } from "./canais-whatsapp.bridge"

describe("CanaisWhatsappBridgeService", () => {
  it("implementa os cinco endpoints do contrato do console", async () => {
    const seen: Array<{ method: string; path: string; body: string }> = []
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => { body += chunk })
      request.on("end", () => {
        seen.push({ method: request.method ?? "", path: request.url ?? "", body })
        response.statusCode = 200
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(request.url === "/api/whatsapp/login/start"
          ? { qr: "data:image/png;base64,qr", expiresAt: "2026-11-18T12:00:00.000Z" }
          : request.url === "/api/whatsapp/login/wait"
            ? { status: "paired", phone: "11999998888" }
            : request.url === "/api/whatsapp/status"
              ? [{ accountId: "acme", connected: true, phone: "11999998888", agentId: "agent-acme" }]
              : { ok: true }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("servidor de teste sem porta")
    const bridge = new CanaisWhatsappBridgeService({ get: (key: string) => key === "CANAIS_BFF_UPSTREAM" ? `http://127.0.0.1:${address.port}` : key === "CANAIS_BFF_TOKEN" ? "token" : undefined } as never)

    await expect(bridge.loginStart("acme")).resolves.toMatchObject({ qr: "data:image/png;base64,qr" })
    await expect(bridge.loginWait("acme")).resolves.toMatchObject({ status: "paired" })
    await expect(bridge.status()).resolves.toHaveLength(1)
    await expect(bridge.provision({ accountId: "acme", agentId: "agent-acme", displayName: "Acme" })).resolves.toBeUndefined()
    await expect(bridge.remove("acme")).resolves.toBeUndefined()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

    expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual([
      "POST /api/whatsapp/login/start",
      "POST /api/whatsapp/login/wait",
      "GET /api/whatsapp/status",
      "POST /api/whatsapp/provision",
      "DELETE /api/whatsapp/login",
    ])
    const start = seen.at(0)
    const provision = seen.at(3)
    expect(start && JSON.parse(start.body)).toEqual({ accountId: "acme" })
    expect(provision && JSON.parse(provision.body)).toEqual({ accountId: "acme", agentId: "agent-acme", displayName: "Acme" })
  })
})
