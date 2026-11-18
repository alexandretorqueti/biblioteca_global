import { describe, expect, it, vi } from "vitest"
import { CanaisWhatsappReconciler } from "./canais-whatsapp.reconciler"

describe("CanaisWhatsappReconciler", () => {
  it("marca ativo como expirado e alerta quando a conta desconecta", async () => {
    const current = { id: 4, tenantId: 9, tenantSlug: "acme", tenantNome: "Acme", accountId: "acme", numero: "11999998888", agentId: "agent-acme", estado: "ativo" as const, ultimoStatusEm: null, createdAt: new Date(), updatedAt: new Date() }
    const repository = { list: vi.fn().mockResolvedValue([current]), update: vi.fn().mockResolvedValue(undefined) }
    const bridge = { status: vi.fn().mockResolvedValue([]) }
    const alert = { send: vi.fn().mockResolvedValue(undefined) }
    const reconciler = new CanaisWhatsappReconciler(repository as never, bridge as never, alert, { intervalMs: 999_999 })
    await reconciler.reconcile()
    expect(repository.update).toHaveBeenCalledWith(4, expect.objectContaining({ estado: "expirado" }))
    expect(alert.send).toHaveBeenCalledWith(expect.stringContaining("tenant=acme"))
  })
})
