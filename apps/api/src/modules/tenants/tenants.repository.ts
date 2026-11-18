import { Inject, Injectable } from "@nestjs/common"
import { and, eq } from "drizzle-orm"
import { tenantTools, tenants } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export type TenantStatus = "ativo" | "suspenso" | "onboarding"

export interface TenantRow {
  id: number
  slug: string
  nome: string
  dominio: string | null
  status: TenantStatus
  configJson: unknown
}

export interface TenantToolRow {
  toolKey: string
}

export interface TenantsRepository {
  findBySlug(slug: string): Promise<TenantRow | undefined>
  findByDomain(domain: string): Promise<TenantRow | undefined>
  listActiveTools(tenantId: number): Promise<TenantToolRow[]>
}

export const TENANTS_REPOSITORY = Symbol("TENANTS_REPOSITORY")

@Injectable()
export class DrizzleTenantsRepository implements TenantsRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async findBySlug(slug: string): Promise<TenantRow | undefined> {
    const rows = await this.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        nome: tenants.nome,
        dominio: tenants.dominio,
        status: tenants.status,
        configJson: tenants.configJson,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1)
    return rows.at(0)
  }

  async findByDomain(domain: string): Promise<TenantRow | undefined> {
    const rows = await this.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        nome: tenants.nome,
        dominio: tenants.dominio,
        status: tenants.status,
        configJson: tenants.configJson,
      })
      .from(tenants)
      .where(eq(tenants.dominio, domain))
      .limit(1)
    return rows.at(0)
  }

  async listActiveTools(tenantId: number): Promise<TenantToolRow[]> {
    return this.db
      .select({ toolKey: tenantTools.toolKey })
      .from(tenantTools)
      .where(and(eq(tenantTools.tenantId, tenantId), eq(tenantTools.ativo, true)))
      .orderBy(tenantTools.toolKey)
  }
}
