import { Inject, Injectable } from "@nestjs/common"
import { and, eq } from "drizzle-orm"
import { tenantCanaisWhatsapp, tenants } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import type { CanalWhatsappEstado, CanalWhatsappRow } from "./canais-whatsapp.types"

export interface CanaisWhatsappRepository {
  findByTenantSlug(slug: string): Promise<CanalWhatsappRow | undefined>
  findById(id: number): Promise<CanalWhatsappRow | undefined>
  findAtivoByNumero(numero: string): Promise<CanalWhatsappRow | undefined>
  list(): Promise<CanalWhatsappRow[]>
  insert(input: { tenantId: number; accountId: string; estado: CanalWhatsappEstado; agentId?: string | null }): Promise<number>
  update(id: number, values: Partial<{ estado: CanalWhatsappEstado; numero: string | null; agentId: string | null; ultimoStatusEm: Date }>): Promise<void>
}

export const CANAIS_WHATSAPP_REPOSITORY = Symbol("CANAIS_WHATSAPP_REPOSITORY")

@Injectable()
export class DrizzleCanaisWhatsappRepository implements CanaisWhatsappRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  private selection() {
    return { id: tenantCanaisWhatsapp.id, tenantId: tenantCanaisWhatsapp.tenantId, tenantSlug: tenants.slug, tenantNome: tenants.nome, accountId: tenantCanaisWhatsapp.accountId, numero: tenantCanaisWhatsapp.numero, agentId: tenantCanaisWhatsapp.agentId, estado: tenantCanaisWhatsapp.estado, ultimoStatusEm: tenantCanaisWhatsapp.ultimoStatusEm, createdAt: tenantCanaisWhatsapp.createdAt, updatedAt: tenantCanaisWhatsapp.updatedAt }
  }

  async findByTenantSlug(slug: string): Promise<CanalWhatsappRow | undefined> {
    const rows = await this.db.select(this.selection()).from(tenantCanaisWhatsapp).innerJoin(tenants, eq(tenants.id, tenantCanaisWhatsapp.tenantId)).where(eq(tenants.slug, slug)).limit(1)
    return rows.at(0)
  }
  async findById(id: number): Promise<CanalWhatsappRow | undefined> {
    const rows = await this.db.select(this.selection()).from(tenantCanaisWhatsapp).innerJoin(tenants, eq(tenants.id, tenantCanaisWhatsapp.tenantId)).where(eq(tenantCanaisWhatsapp.id, id)).limit(1)
    return rows.at(0)
  }
  async findAtivoByNumero(numero: string): Promise<CanalWhatsappRow | undefined> {
    const rows = await this.db.select(this.selection()).from(tenantCanaisWhatsapp).innerJoin(tenants, eq(tenants.id, tenantCanaisWhatsapp.tenantId)).where(and(eq(tenantCanaisWhatsapp.numero, numero), eq(tenantCanaisWhatsapp.estado, "ativo"))).limit(1)
    return rows.at(0)
  }
  async list(): Promise<CanalWhatsappRow[]> {
    return this.db.select(this.selection()).from(tenantCanaisWhatsapp).innerJoin(tenants, eq(tenants.id, tenantCanaisWhatsapp.tenantId)).orderBy(tenants.slug)
  }
  async insert(input: { tenantId: number; accountId: string; estado: CanalWhatsappEstado; agentId?: string | null }): Promise<number> {
    const result = await this.db.insert(tenantCanaisWhatsapp).values(input).$returningId()
    const id = result[0]?.id
    if (!id) throw new Error("Falha ao persistir vínculo WhatsApp")
    return id
  }
  async update(id: number, values: Partial<{ estado: CanalWhatsappEstado; numero: string | null; agentId: string | null; ultimoStatusEm: Date }>): Promise<void> {
    await this.db.update(tenantCanaisWhatsapp).set({ ...values, updatedAt: new Date() }).where(eq(tenantCanaisWhatsapp.id, id))
  }
}
