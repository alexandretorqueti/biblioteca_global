import { describe, expect, it, vi } from "vitest"
import { WhatsappChannelsClient } from "../whatsapp-client"

describe("WhatsappChannelsClient", () => {
  it("inicia pareamento com accountId no tenant", async () => {
    const request = vi.fn().mockResolvedValue({ qr: "data:image/png;base64,qr", expiresAt: "2026-11-18T12:00:00.000Z" })
    const client = new WhatsappChannelsClient({ request } as never)

    await client.startPairing(7, "tenant-teste")

    expect(request).toHaveBeenCalledWith("POST", "/tenants/7/whatsapp/pairing", {
      body: { accountId: "tenant-teste" },
      auth: "access",
    })
  })

  it("expõe consulta, listagem e remoção tipadas", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ accountId: "tenant-teste", estado: "ativo", numero: "11999998888", agentId: null, ultimoStatusEm: null })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ ok: true, accountId: "tenant-teste" })
    const client = new WhatsappChannelsClient({ request } as never)

    await client.getPairingStatus(7, "tenant-teste")
    await client.list(7)
    await client.remove(7, "tenant-teste")

    expect(request).toHaveBeenNthCalledWith(1, "GET", "/tenants/7/whatsapp/pairing/tenant-teste", { auth: "access" })
    expect(request).toHaveBeenNthCalledWith(2, "GET", "/tenants/7/whatsapp", { auth: "access" })
    expect(request).toHaveBeenNthCalledWith(3, "DELETE", "/tenants/7/whatsapp/tenant-teste", { auth: "access" })
  })
})
