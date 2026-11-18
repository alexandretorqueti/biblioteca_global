import { tenantConfigAdminViewSchema, tenantConversaHistoricoSchema, tenantConversaItemSchema, tenantConversasFiltrosSchema, tenantLeadItemSchema, tenantLeadsFiltrosSchema, tenantMetricasSchema, type TenantConfigAdminInput, type TenantConfigAdminView, type TenantConversaHistorico, type TenantConversaItem, type TenantConversasFiltros, type TenantLeadItem, type TenantLeadsFiltros, type TenantMetricas } from "@biblioteca-global/shared"
import { z } from "zod"
import { ApiClientError } from "./errors"
import type { ApiHttpClient } from "./http"
const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int().nonnegative() }).strict()
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (result.success) return result.data; throw new ApiClientError(500, "INVALID_RESPONSE", "Resposta inválida da API", result.error.issues) }
function query(f: TenantConversasFiltros | TenantLeadsFiltros): Record<string, string | number | undefined> { return { busca: f.busca, canal: "canal" in f ? f.canal : undefined, status: "status" in f ? f.status : undefined, ferramenta: "ferramenta" in f ? f.ferramenta : undefined, "periodo.de": f.periodo?.de, "periodo.ate": f.periodo?.ate, pagina: f.pagina, tamanho: f.tamanho } }
export class PainelTenantClient {
  constructor(private readonly http: ApiHttpClient) {}
  private path(slug: string, suffix: string): string { return `/painel-tenant/${encodeURIComponent(slug)}${suffix}` }
  async listConversas(slug: string, filtros: Partial<TenantConversasFiltros> = {}): Promise<{ items: TenantConversaItem[]; total: number }> { const f = tenantConversasFiltrosSchema.parse({ pagina: 1, tamanho: 20, ...filtros }); return parse(page(tenantConversaItemSchema), await this.http.request("GET", this.path(slug, "/conversas"), { query: query(f), auth: "access" })) }
  async getHistorico(slug: string, id: number): Promise<TenantConversaHistorico> { return parse(tenantConversaHistoricoSchema, await this.http.request("GET", this.path(slug, `/conversas/${id}/mensagens`), { auth: "access" })) }
  async listLeads(slug: string, filtros: Partial<TenantLeadsFiltros> = {}): Promise<{ items: TenantLeadItem[]; total: number }> { const f = tenantLeadsFiltrosSchema.parse({ pagina: 1, tamanho: 20, ...filtros }); return parse(page(tenantLeadItemSchema), await this.http.request("GET", this.path(slug, "/leads"), { query: query(f), auth: "access" })) }
  async exportLeadsCsv(slug: string, filtros: Partial<TenantLeadsFiltros> = {}): Promise<string> { const f = tenantLeadsFiltrosSchema.parse({ pagina: 1, tamanho: 100, ...filtros }); return this.http.request("GET", this.path(slug, "/leads/export"), { query: query(f), auth: "access", responseType: "text" }) }
  async getMetricas(slug: string, mes?: string): Promise<TenantMetricas> { return parse(tenantMetricasSchema, await this.http.request("GET", this.path(slug, "/metricas"), { query: { mes }, auth: "access" })) }
  async getConfig(slug: string): Promise<TenantConfigAdminView> { return parse(tenantConfigAdminViewSchema, await this.http.request("GET", this.path(slug, "/config"), { auth: "access" })) }
  async updateConfig(slug: string, input: TenantConfigAdminInput): Promise<TenantConfigAdminView> { return parse(tenantConfigAdminViewSchema, await this.http.request("PUT", this.path(slug, "/config"), { body: input, auth: "access" })) }
}
export function createPainelTenantClient(http: ApiHttpClient): PainelTenantClient { return new PainelTenantClient(http) }
