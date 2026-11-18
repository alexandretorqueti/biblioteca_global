import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common"
import { normalizeBrPhone, phoneSlug } from "@biblioteca-global/shared"
import { TENANTS_REPOSITORY, type TenantRow, type TenantsRepository } from "../tenants/tenants.repository"
import { CANAIS_WHATSAPP_REPOSITORY, type CanaisWhatsappRepository } from "./canais-whatsapp.repository"
import { CANAIS_WHATSAPP_BRIDGE, type CanalWhatsappResolverResult, type CanaisWhatsappBridge } from "./canais-whatsapp.types"

function agentIdFromConfig(config: unknown): string | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined
  const record = config as Record<string, unknown>
  for (const key of ["agentId", "agenteId", "agent_id"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim()
  }
  return undefined
}

@Injectable()
export class CanaisWhatsappService {
  constructor(
    @Inject(CANAIS_WHATSAPP_REPOSITORY) private readonly repository: CanaisWhatsappRepository,
    @Inject(TENANTS_REPOSITORY) private readonly tenants: TenantsRepository,
    @Inject(CANAIS_WHATSAPP_BRIDGE) private readonly bridge: CanaisWhatsappBridge,
  ) {}

  async iniciarPareamento(tenantSlug: string) {
    const tenant = await this.tenant(tenantSlug)
    const accountId = tenant.slug
    const existing = await this.repository.findByTenantSlug(tenant.slug)
    const agentId = existing?.agentId ?? agentIdFromConfig(tenant.configJson)
    if (!agentId) throw new BadRequestException("agente não configurado")
    if (existing) await this.repository.update(existing.id, { estado: "pareando", agentId })
    else await this.repository.insert({ tenantId: tenant.id, accountId, estado: "pareando", agentId })
    const login = await this.bridge.loginStart(accountId)
    return { accountId, qr: login.qr, expiresAt: login.expiresAt }
  }

  async confirmarPareamento(tenantSlug: string) {
    const row = await this.repository.findByTenantSlug(tenantSlug)
    if (!row) throw new NotFoundException("Pareamento WhatsApp não iniciado")
    const result = await this.bridge.loginWait(row.accountId)
    if (result.status === "expired" || result.status === "failed") {
      await this.repository.update(row.id, { estado: "expirado", ultimoStatusEm: new Date() })
    } else if (result.status === "paired") {
      const agentId = row.agentId ?? agentIdFromConfig((await this.tenants.findBySlug(row.tenantSlug))?.configJson)
      if (!agentId) throw new BadRequestException("agente não configurado")
      await this.bridge.provision({ accountId: row.accountId, agentId, displayName: row.tenantNome })
      await this.repository.update(row.id, { estado: "ativo", numero: result.phone ? normalizeBrPhone(result.phone) : null, agentId, ultimoStatusEm: new Date() })
    }
    return this.repository.findById(row.id)
  }

  async remover(id: number): Promise<{ ok: true; accountId: string }> {
    const row = await this.repository.findById(id)
    if (!row) throw new NotFoundException("Vínculo WhatsApp não encontrado")
    await this.bridge.remove(row.accountId)
    await this.repository.update(row.id, { estado: "removido", ultimoStatusEm: new Date() })
    return { ok: true, accountId: row.accountId }
  }

  async listar() { return this.repository.list() }

  async resolverPorNumero(numero: string): Promise<CanalWhatsappResolverResult> {
    let normalized: string
    try { normalized = normalizeBrPhone(numero) } catch { return { status: "desconhecido" } }
    const row = await this.repository.findAtivoByNumero(normalized)
    if (!row || !row.agentId) return { status: "desconhecido" }
    return { status: "encontrado", tenantId: row.tenantId, slug: row.tenantSlug, agentId: row.agentId, sessionKey: `agent:${row.agentId}:${phoneSlug(normalized)}` }
  }

  private async tenant(slug: string): Promise<TenantRow> {
    const tenant = await this.tenants.findBySlug(slug)
    if (!tenant) throw new NotFoundException("Tenant não encontrado")
    return tenant
  }
}
