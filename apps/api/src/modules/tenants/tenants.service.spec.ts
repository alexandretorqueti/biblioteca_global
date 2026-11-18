import { describe, expect, it, vi } from "vitest"
import { normalizeTenantHost, TenantsService } from "./tenants.service"
import type { TenantRow, TenantsRepository } from "./tenants.repository"

function tenant(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: 1,
    slug: "alpha",
    nome: "Alpha",
    dominio: "alpha.example.com",
    status: "ativo",
    configJson: {
      paleta: { primaria: "#112233" },
      segredo: "não expor",
    },
    ...overrides,
  }
}

function repository(overrides: Partial<TenantsRepository> = {}): TenantsRepository {
  return {
    findBySlug: vi.fn().mockResolvedValue(undefined),
    findByDomain: vi.fn().mockResolvedValue(undefined),
    listActiveTools: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

describe("TenantsService", () => {
  it("normaliza domínio removendo esquema, porta e ponto final", () => {
    expect(normalizeTenantHost("HTTPS://Alpha.Example.com:8443/atendimento")).toBe(
      "alpha.example.com",
    )
    expect(normalizeTenantHost("alpha.example.com:443")).toBe("alpha.example.com")
  })

  it("resolve por domínio e usa slug como fallback", async () => {
    const repo = repository({
      findByDomain: vi.fn().mockResolvedValue(undefined),
      findBySlug: vi.fn().mockResolvedValue(tenant()),
    })
    const service = new TenantsService(repo)

    await expect(service.resolveTenant({ host: "unknown.example.com:443", slug: "alpha" }))
      .resolves.toEqual(tenant())
    expect(repo.findByDomain).toHaveBeenCalledWith("unknown.example.com")
    expect(repo.findBySlug).toHaveBeenCalledWith("alpha")
  })

  it("prefere o tenant encontrado pelo domínio", async () => {
    const byHost = tenant({ id: 2, slug: "host-tenant" })
    const repo = repository({
      findByDomain: vi.fn().mockResolvedValue(byHost),
      findBySlug: vi.fn(),
    })
    const service = new TenantsService(repo)

    await expect(service.resolveTenant({ host: "alpha.example.com:443", slug: "alpha" }))
      .resolves.toEqual(byHost)
    expect(repo.findBySlug).not.toHaveBeenCalled()
  })

  it("projeta defaults e somente ferramentas ativas do tenant resolvido", async () => {
    const repo = repository({
      findBySlug: vi.fn().mockResolvedValue(tenant()),
      listActiveTools: vi.fn().mockResolvedValue([
        { toolKey: "agenda" },
        { toolKey: "captura-lead" },
      ]),
    })
    const service = new TenantsService(repo)

    await expect(service.getChatConfig("alpha")).resolves.toMatchObject({
      nome: "Alpha",
      paleta: { primaria: "#112233", secundaria: "#0F172A" },
      ferramentas: ["agenda", "captura-lead"],
    })
    expect(repo.listActiveTools).toHaveBeenCalledWith(1)
    expect(JSON.stringify(await service.getChatConfig("alpha"))).not.toContain("não expor")
  })
})
