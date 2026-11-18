import { Inject, Injectable } from "@nestjs/common"
import { and, asc, desc, eq, gte, like, lt, lte, or, sql } from "drizzle-orm"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import {
  assinaturas, planosProduto, tenantConversas, tenantConversaMensagens,
  tenantCotaAlertas, tenantLeads, tenantTools, tenants, transbordoConfig,
} from "../../../../../database/schema"

export interface TenantPanelRepository {
  findTenant(slug: string): Promise<typeof tenants.$inferSelect | undefined>
  listConversas(tenantId: number, filters: Record<string, unknown>): Promise<{ items: unknown[]; total: number }>
  findConversa(tenantId: number, id: number): Promise<unknown | undefined>
  listMensagens(conversaId: number): Promise<unknown[]>
  listLeads(tenantId: number, filters: Record<string, unknown>): Promise<{ items: unknown[]; total: number }>
  countConversas(tenantId: number, de: Date, ate: Date): Promise<number>
  averageResponse(tenantId: number, de: Date, ate: Date): Promise<number | null>
  topThemes(tenantId: number, de: Date, ate: Date): Promise<Array<{ tema: string | null; quantidade: number }>>
  quota(tenantId: number, slug: string): Promise<{ planoSlug: string; limite: number | null }>
  markQuotaAlert(tenantId: number, mes: string): Promise<boolean>
  getConfig(tenantId: number, slug: string): Promise<unknown>
  saveConfig(tenantId: number, slug: string, input: { configJson: unknown; ferramentas?: Array<{ toolKey: string; params: unknown; ativo: boolean }>; transbordo?: unknown | null; retencaoConversasDias?: number | null }): Promise<void>
  ingestConversation(tenantId: number, input: Record<string, unknown>): Promise<unknown>
  ingestLead(tenantId: number, input: Record<string, unknown>): Promise<unknown>
  purge(now: Date): Promise<number>
}

@Injectable()
export class DrizzleTenantPanelRepository implements TenantPanelRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async findTenant(slug: string) { return (await this.db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1))[0] }

  async listConversas(tenantId: number, filters: Record<string, unknown>) {
    const conditions = [eq(tenantConversas.tenantId, tenantId)]
    if (typeof filters.canal === "string") conditions.push(eq(tenantConversas.canal, filters.canal as "web" | "whatsapp"))
    if (typeof filters.status === "string") conditions.push(eq(tenantConversas.status, filters.status as "ativa" | "finalizada" | "transbordada"))
    const periodo = filters.periodo as { de?: string; ate?: string } | undefined
    if (periodo?.de) conditions.push(gte(tenantConversas.ultimaMensagemEm, new Date(periodo.de)))
    if (periodo?.ate) conditions.push(lte(tenantConversas.ultimaMensagemEm, new Date(periodo.ate)))
    if (typeof filters.busca === "string") {
      const term = `%${filters.busca}%`
      conditions.push(or(like(tenantConversas.externalId, term), like(tenantConversas.visitanteKey, term), like(tenantConversas.contatoNome, term), like(tenantConversas.contatoEmail, term)) as never)
    }
    const pagina = Number(filters.pagina ?? 1), tamanho = Number(filters.tamanho ?? 20)
    const [items, count] = await Promise.all([
      this.db.select().from(tenantConversas).where(and(...conditions)).orderBy(desc(tenantConversas.ultimaMensagemEm)).limit(tamanho).offset((pagina - 1) * tamanho),
      this.db.select({ total: sql<number>`count(*)` }).from(tenantConversas).where(and(...conditions)),
    ])
    return { items, total: Number(count[0]?.total ?? 0) }
  }

  async findConversa(tenantId: number, id: number) { return (await this.db.select().from(tenantConversas).where(and(eq(tenantConversas.tenantId, tenantId), eq(tenantConversas.id, id))).limit(1))[0] }
  async listMensagens(conversaId: number) { return this.db.select().from(tenantConversaMensagens).where(eq(tenantConversaMensagens.conversaId, conversaId)).orderBy(asc(tenantConversaMensagens.criadaEm), asc(tenantConversaMensagens.id)) }

  async listLeads(tenantId: number, filters: Record<string, unknown>) {
    const conditions = [eq(tenantLeads.tenantId, tenantId)]
    if (typeof filters.ferramenta === "string") conditions.push(eq(tenantLeads.ferramenta, filters.ferramenta))
    const periodo = filters.periodo as { de?: string; ate?: string } | undefined
    if (periodo?.de) conditions.push(gte(tenantLeads.criadoEm, new Date(periodo.de)))
    if (periodo?.ate) conditions.push(lte(tenantLeads.criadoEm, new Date(periodo.ate)))
    if (typeof filters.busca === "string") conditions.push(like(tenantLeads.dadosJson, `%${filters.busca}%`) as never)
    const pagina = Number(filters.pagina ?? 1), tamanho = Number(filters.tamanho ?? 20)
    const [items, count] = await Promise.all([
      this.db.select().from(tenantLeads).where(and(...conditions)).orderBy(desc(tenantLeads.criadoEm)).limit(tamanho).offset((pagina - 1) * tamanho),
      this.db.select({ total: sql<number>`count(*)` }).from(tenantLeads).where(and(...conditions)),
    ])
    return { items, total: Number(count[0]?.total ?? 0) }
  }

  async countConversas(tenantId: number, de: Date, ate: Date) { const r = await this.db.select({ total: sql<number>`count(*)` }).from(tenantConversas).where(and(eq(tenantConversas.tenantId, tenantId), gte(tenantConversas.createdAt, de), lt(tenantConversas.createdAt, ate))); return Number(r[0]?.total ?? 0) }
  async averageResponse(tenantId: number, de: Date, ate: Date) {
    const rows = await this.db.execute(sql`SELECT AVG(TIMESTAMPDIFF(SECOND, anterior.criada_em, atual.criada_em)) AS media FROM tenant_conversa_mensagens atual JOIN tenant_conversas c ON c.id=atual.conversa_id JOIN tenant_conversa_mensagens anterior ON anterior.id=(SELECT MAX(p.id) FROM tenant_conversa_mensagens p WHERE p.conversa_id=atual.conversa_id AND p.criada_em >= ${de} AND (p.criada_em < atual.criada_em OR (p.criada_em = atual.criada_em AND p.id < atual.id))) WHERE c.tenant_id=${tenantId} AND atual.criada_em >= ${de} AND atual.criada_em < ${ate} AND atual.role='agente' AND anterior.role='visitante'`)
    const row = (rows as unknown as Array<{ media: number | null }>)[0]
    return row?.media == null ? null : Number(row.media)
  }
  async topThemes(tenantId: number, de: Date, ate: Date) { const rows = await this.db.select({ tema: tenantConversas.tema, quantidade: sql<number>`count(*)` }).from(tenantConversas).where(and(eq(tenantConversas.tenantId, tenantId), gte(tenantConversas.createdAt, de), lt(tenantConversas.createdAt, ate))).groupBy(tenantConversas.tema).orderBy(desc(sql`count(*)`)).limit(5); return rows.map((r) => ({ ...r, quantidade: Number(r.quantidade) })) }
  async quota(tenantId: number, slug: string) {
    const rows = await this.db.select({ assinaturaSlug: planosProduto.slug, limites: planosProduto.limitesCotas, fallbackSlug: tenants.plano }).from(tenants).leftJoin(assinaturas, and(or(eq(assinaturas.tenantId, tenantId), eq(assinaturas.tenantSlug, slug)), eq(assinaturas.status, "active"))).leftJoin(planosProduto, eq(planosProduto.id, assinaturas.planoProdutoId)).where(eq(tenants.id, tenantId)).limit(1)
    const row = rows[0]; const planoSlug = row?.assinaturaSlug ?? row?.fallbackSlug ?? "starter"; const limites = row?.limites as { conversasPorMes?: number } | null | undefined
    return { planoSlug, limite: limites?.conversasPorMes == null ? null : Number(limites.conversasPorMes) }
  }
  async markQuotaAlert(tenantId: number, mes: string) { const exists = await this.db.select({ id: tenantCotaAlertas.id }).from(tenantCotaAlertas).where(and(eq(tenantCotaAlertas.tenantId, tenantId), eq(tenantCotaAlertas.mesCompetencia, mes))).limit(1); if (exists[0]) return false; await this.db.insert(tenantCotaAlertas).values({ tenantId, mesCompetencia: mes }); return true }
  async getConfig(tenantId: number, slug: string) { const t = (await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0]; const tools = await this.db.select().from(tenantTools).where(eq(tenantTools.tenantId, tenantId)); const trans = (await this.db.select().from(transbordoConfig).where(eq(transbordoConfig.tenantSlug, slug)).limit(1))[0]; return { tenant: t, tools, transbordo: trans } }
  async saveConfig(tenantId: number, slug: string, input: { configJson: unknown; ferramentas?: Array<{ toolKey: string; params: unknown; ativo: boolean }>; transbordo?: unknown | null; retencaoConversasDias?: number | null }) {
    await this.db.transaction(async (tx) => {
      await tx.update(tenants).set({ configJson: input.configJson, ...(input.retencaoConversasDias !== undefined ? { retencaoConversasDias: input.retencaoConversasDias } : {}) }).where(eq(tenants.id, tenantId))
      if (input.ferramentas) { await tx.delete(tenantTools).where(eq(tenantTools.tenantId, tenantId)); if (input.ferramentas.length) await tx.insert(tenantTools).values(input.ferramentas.map((f) => ({ tenantId, toolKey: f.toolKey, paramsJson: f.params, ativo: f.ativo }))) }
      if (input.transbordo !== undefined) { await tx.delete(transbordoConfig).where(eq(transbordoConfig.tenantSlug, slug)); if (input.transbordo) { const v = input.transbordo as { ativo: boolean; destino: { tipo: "email" | "telegram" | "whatsapp"; valor: string; nomeAtendente: string }; horario: unknown }; await tx.insert(transbordoConfig).values({ tenantSlug: slug, ativo: v.ativo, destinoTipo: v.destino.tipo, destinoValor: v.destino.valor, atendenteNome: v.destino.nomeAtendente, horario: v.horario }) } }
    })
  }
  async ingestConversation(tenantId: number, input: Record<string, unknown>) { const externalId = String(input.externalId); const existing = await this.db.select().from(tenantConversas).where(and(eq(tenantConversas.tenantId, tenantId), eq(tenantConversas.externalId, externalId))).limit(1); const mensagens = input.mensagens as Array<{ role: "visitante" | "agente" | "sistema"; texto: string; criadaEm: string }>; const primeira = mensagens[0]!; const ultima = mensagens.at(-1)!; if (!existing[0]) { const first = new Date(primeira.criadaEm), last = new Date(ultima.criadaEm); const result = await this.db.insert(tenantConversas).values({ tenantId, externalId, canal: input.canal as "web" | "whatsapp", visitanteKey: String(input.visitanteKey), contatoNome: input.contatoNome as string | undefined, contatoEmail: input.contatoEmail as string | undefined, tema: input.tema as string | null | undefined, status: input.status as "ativa" | "finalizada" | "transbordada", primeiraMensagemEm: first, ultimaMensagemEm: last }); const id = Number(result[0].insertId); await this.db.insert(tenantConversaMensagens).values(mensagens.map((m) => ({ conversaId: id, role: m.role, texto: m.texto, criadaEm: new Date(m.criadaEm) }))); return { id, criada: true } } const id = existing[0].id; const known = await this.db.select({ texto: tenantConversaMensagens.texto, criadaEm: tenantConversaMensagens.criadaEm }).from(tenantConversaMensagens).where(eq(tenantConversaMensagens.conversaId, id)); const novos = mensagens.filter((m) => !known.some((k) => k.texto === m.texto && k.criadaEm.getTime() === new Date(m.criadaEm).getTime())); if (novos.length) await this.db.insert(tenantConversaMensagens).values(novos.map((m) => ({ conversaId: id, role: m.role, texto: m.texto, criadaEm: new Date(m.criadaEm) }))); await this.db.update(tenantConversas).set({ ultimaMensagemEm: new Date(ultima.criadaEm), status: input.status as "ativa" | "finalizada" | "transbordada", tema: input.tema as string | null | undefined }).where(eq(tenantConversas.id, id)); return { id, criada: false }
  }
  async ingestLead(tenantId: number, input: Record<string, unknown>) { let conversaId: number | null = null; if (input.conversaExternalId) conversaId = (await this.db.select({ id: tenantConversas.id }).from(tenantConversas).where(and(eq(tenantConversas.tenantId, tenantId), eq(tenantConversas.externalId, String(input.conversaExternalId)))).limit(1))[0]?.id ?? null; const externalId = input.externalId == null ? null : String(input.externalId); if (externalId) { const existing = (await this.db.select({ id: tenantLeads.id }).from(tenantLeads).where(and(eq(tenantLeads.tenantId, tenantId), eq(tenantLeads.externalId, externalId))).limit(1))[0]; if (existing) return { id: existing.id, criado: false } } const result = await this.db.insert(tenantLeads).values({ tenantId, conversaId, ferramenta: String(input.ferramenta), dadosJson: input.dadosJson, externalId, criadoEm: input.criadoEm ? new Date(String(input.criadoEm)) : new Date() }); return { id: Number(result[0].insertId), criado: true } }
  async purge(now: Date) { const rows = await this.db.select({ id: tenants.id, dias: tenants.retencaoConversasDias }).from(tenants).where(sql`${tenants.retencaoConversasDias} IS NOT NULL`); let total = 0; for (const row of rows) { const limite = new Date(now.getTime() - Number(row.dias) * 86400000); const old = await this.db.select({ id: tenantConversas.id }).from(tenantConversas).where(and(eq(tenantConversas.tenantId, row.id), lt(tenantConversas.ultimaMensagemEm, limite))); for (const c of old) { await this.db.delete(tenantConversas).where(eq(tenantConversas.id, c.id)); total++ } } return total }
}
