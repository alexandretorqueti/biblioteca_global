import { describe, expect, it, vi } from "vitest"
import { CanaisWhatsappService } from "./canais-whatsapp.service"

function row(overrides: Record<string, unknown> = {}) {
  return { id: 1, tenantId: 7, tenantSlug: "acme", tenantNome: "Acme", accountId: "acme", numero: null, agentId: "agent-acme", estado: "pareando" as const, ultimoStatusEm: null, createdAt: new Date(), updatedAt: new Date(), ...overrides }
}

function setup(overrides: { existing?: ReturnType<typeof row>; wait?: Record<string, unknown> } = {}) {
  const repository = {
    findByTenantSlug: vi.fn().mockResolvedValue(overrides.existing),
    findById: vi.fn().mockResolvedValue(overrides.existing ?? row({ estado: "ativo", numero: "11999998888" })),
    findAtivoByNumero: vi.fn().mockResolvedValue(row({ estado: "ativo", numero: "11999998888" })),
    list: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue(1),
    update: vi.fn().mockResolvedValue(undefined),
  }
  const tenants = { findBySlug: vi.fn().mockResolvedValue({ id: 7, slug: "acme", nome: "Acme", status: "ativo", configJson: { agentId: "agent-acme" } }) }
  const bridge = {
    loginStart: vi.fn().mockResolvedValue({ qr: "data:image/png;base64,qr", expiresAt: "2026-11-18T12:00:00.000Z" }),
    loginWait: vi.fn().mockResolvedValue({ status: "paired", phone: "11999998888" }),
    provision: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue([]),
  }
  return { service: new CanaisWhatsappService(repository as never, tenants as never, bridge as never), repository, tenants, bridge }
}

describe("CanaisWhatsappService", () => {
  it("inicia pareamento de forma idempotente para registro existente", async () => {
    const current = row()
    const { service, repository, bridge } = setup({ existing: current })
    await service.iniciarPareamento("acme")
    expect(repository.insert).not.toHaveBeenCalled()
    expect(repository.update).toHaveBeenCalledWith(1, { estado: "pareando", agentId: "agent-acme" })
    expect(bridge.loginStart).toHaveBeenCalledWith("acme")
  })

  it("recusa pareamento quando o tenant não tem agente", async () => {
    const { service, tenants } = setup()
    tenants.findBySlug.mockResolvedValue({ id: 7, slug: "acme", nome: "Acme", status: "ativo", configJson: {} })
    await expect(service.iniciarPareamento("acme")).rejects.toThrow("agente não configurado")
  })

  it("provisiona e torna ativo quando o console confirma paired", async () => {
    const current = row()
    const { service, repository, bridge } = setup({ existing: current })
    await service.confirmarPareamento("acme")
    expect(bridge.provision).toHaveBeenCalledWith({ accountId: "acme", agentId: "agent-acme", displayName: "Acme" })
    expect(repository.update).toHaveBeenCalledWith(1, expect.objectContaining({ estado: "ativo", numero: "11999998888", agentId: "agent-acme" }))
  })

  it("resolve telefone ativo na sessão canônica do agente", async () => {
    const { service } = setup()
    await expect(service.resolverPorNumero("(11) 99999-8888")).resolves.toEqual({ status: "encontrado", tenantId: 7, slug: "acme", agentId: "agent-acme", sessionKey: "agent:agent-acme:telefone-11999998888" })
  })
})
