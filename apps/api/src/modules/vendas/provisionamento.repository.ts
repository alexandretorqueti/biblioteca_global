import { Inject, Injectable } from "@nestjs/common"
import { and, asc, eq, lte, or, sql } from "drizzle-orm"
import { assinaturas, negocioDocumentos, negocios, pedidosVenda, planosProduto, provisionamentoPendente, tenants } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export const PROVISIONAMENTO_REPOSITORY = Symbol("PROVISIONAMENTO_REPOSITORY")
export type ProvisionamentoRow = typeof provisionamentoPendente.$inferSelect
export type ProvisionamentoContext = {
  outbox: ProvisionamentoRow
  pedido: typeof pedidosVenda.$inferSelect
  assinatura: typeof assinaturas.$inferSelect
  negocio: typeof negocios.$inferSelect
  plano: typeof planosProduto.$inferSelect
  documentos: Array<typeof negocioDocumentos.$inferSelect>
}
export type ProvisionedTenant = typeof tenants.$inferSelect

export interface ProvisionamentoRepository {
  listarParaRetry(agora: Date, limite: number): Promise<ProvisionamentoRow[]>
  claim(id: number): Promise<ProvisionamentoRow | undefined>
  concluir(id: number): Promise<void>
  falhar(id: number, erro: string, proximaTentativaEm: Date): Promise<void>
  tornarDead(id: number): Promise<void>
  contexto(assinaturaId: number): Promise<ProvisionamentoContext | undefined>
  marcarPedido(id: number, status: "aguardando_aceite" | "provisioning" | "provisioned" | "failed" | "refunded"): Promise<void>
  criarOuObterTenant(input: { slug: string; nome: string; plano: "starter" | "pro" | "enterprise"; configJson: object; personaRef: string; contatos: object }): Promise<ProvisionedTenant>
  vincularAssinatura(assinaturaId: number, tenantId: number, slug: string): Promise<void>
  marcarEmailEnviado(pedidoId: number): Promise<void>
  aprovarAceite(pedidoId: number): Promise<boolean>
  rejeitarAceite(pedidoId: number): Promise<{ assinaturaId: number; outboxId: number } | undefined>
  marcarReembolsavel(assinaturaId: number): Promise<void>
  marcarNegocio(negocioId: number, status: "provisionando" | "provisionado" | "falho"): Promise<void>
}

@Injectable()
export class DrizzleProvisionamentoRepository implements ProvisionamentoRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  listarParaRetry(agora: Date, limite: number): Promise<ProvisionamentoRow[]> {
    return this.db.select().from(provisionamentoPendente).where(and(
      or(eq(provisionamentoPendente.status, "pending"), eq(provisionamentoPendente.status, "failed")),
      or(lte(provisionamentoPendente.proximaTentativaEm, agora), sql`${provisionamentoPendente.proximaTentativaEm} IS NULL`),
    )).orderBy(asc(provisionamentoPendente.id)).limit(limite)
  }

  async claim(id: number): Promise<ProvisionamentoRow | undefined> {
    const result = await this.db.update(provisionamentoPendente).set({ status: "processing", tentativas: sql`${provisionamentoPendente.tentativas} + 1` }).where(and(
      eq(provisionamentoPendente.id, id),
      or(eq(provisionamentoPendente.status, "pending"), and(eq(provisionamentoPendente.status, "failed"), or(lte(provisionamentoPendente.proximaTentativaEm, new Date()), sql`${provisionamentoPendente.proximaTentativaEm} IS NULL`))),
    ))
    if (result[0].affectedRows !== 1) return undefined
    const rows = await this.db.select().from(provisionamentoPendente).where(eq(provisionamentoPendente.id, id)).limit(1)
    return rows[0]
  }

  concluir(id: number): Promise<void> { return this.db.update(provisionamentoPendente).set({ status: "done", proximaTentativaEm: null }).where(eq(provisionamentoPendente.id, id)).then(() => undefined) }
  falhar(id: number, _erro: string, proximaTentativaEm: Date): Promise<void> { return this.db.update(provisionamentoPendente).set({ status: "failed", proximaTentativaEm }).where(eq(provisionamentoPendente.id, id)).then(() => undefined) }
  tornarDead(id: number): Promise<void> { return this.db.update(provisionamentoPendente).set({ status: "dead", proximaTentativaEm: null }).where(eq(provisionamentoPendente.id, id)).then(() => undefined) }

  async contexto(assinaturaId: number): Promise<ProvisionamentoContext | undefined> {
    const rows = await this.db.select({ outbox: provisionamentoPendente, pedido: pedidosVenda, assinatura: assinaturas, negocio: negocios, plano: planosProduto })
      .from(provisionamentoPendente)
      .innerJoin(assinaturas, eq(assinaturas.id, provisionamentoPendente.assinaturaId))
      .innerJoin(pedidosVenda, eq(pedidosVenda.assinaturaId, assinaturas.id))
      .innerJoin(negocios, eq(negocios.id, pedidosVenda.negocioId))
      .innerJoin(planosProduto, eq(planosProduto.id, assinaturas.planoProdutoId))
      .where(eq(assinaturas.id, assinaturaId)).limit(1)
    const row = rows[0]
    if (!row) return undefined
    const documentos = await this.db.select().from(negocioDocumentos).where(eq(negocioDocumentos.negocioId, row.negocio.id))
    return { ...row, documentos }
  }

  marcarPedido(id: number, status: "aguardando_aceite" | "provisioning" | "provisioned" | "failed" | "refunded"): Promise<void> { return this.db.update(pedidosVenda).set({ status }).where(eq(pedidosVenda.id, id)).then(() => undefined) }

  async criarOuObterTenant(input: Parameters<ProvisionamentoRepository["criarOuObterTenant"]>[0]): Promise<ProvisionedTenant> {
    await this.db.insert(tenants).values({ ...input, status: "ativo" }).onDuplicateKeyUpdate({ set: { slug: input.slug } })
    const rows = await this.db.select().from(tenants).where(eq(tenants.slug, input.slug)).limit(1)
    if (!rows[0]) throw new Error("Tenant não encontrado após provisionamento")
    return rows[0]
  }

  vincularAssinatura(assinaturaId: number, tenantId: number, slug: string): Promise<void> { return this.db.update(assinaturas).set({ tenantId, tenantSlug: slug }).where(eq(assinaturas.id, assinaturaId)).then(() => undefined) }
  marcarEmailEnviado(pedidoId: number): Promise<void> { return this.db.update(pedidosVenda).set({ welcomeEmailSent: true }).where(eq(pedidosVenda.id, pedidoId)).then(() => undefined) }

  async aprovarAceite(pedidoId: number): Promise<boolean> {
    const rows = await this.db.select({ pedido: pedidosVenda, outbox: provisionamentoPendente }).from(pedidosVenda).innerJoin(assinaturas, eq(assinaturas.id, pedidosVenda.assinaturaId)).innerJoin(provisionamentoPendente, eq(provisionamentoPendente.assinaturaId, assinaturas.id)).where(eq(pedidosVenda.id, pedidoId)).limit(1)
    const row = rows[0]
    if (!row || row.pedido.status !== "aguardando_aceite") return false
    await this.db.update(pedidosVenda).set({ status: "paid" }).where(eq(pedidosVenda.id, pedidoId))
    await this.db.update(provisionamentoPendente).set({ status: "pending", proximaTentativaEm: null }).where(eq(provisionamentoPendente.id, row.outbox.id))
    return true
  }

  async rejeitarAceite(pedidoId: number): Promise<{ assinaturaId: number; outboxId: number } | undefined> {
    const rows = await this.db.select({ pedido: pedidosVenda, assinatura: assinaturas, outbox: provisionamentoPendente }).from(pedidosVenda).innerJoin(assinaturas, eq(assinaturas.id, pedidosVenda.assinaturaId)).innerJoin(provisionamentoPendente, eq(provisionamentoPendente.assinaturaId, assinaturas.id)).where(eq(pedidosVenda.id, pedidoId)).limit(1)
    const row = rows[0]
    if (!row || row.pedido.status !== "aguardando_aceite") return undefined
    await this.db.update(pedidosVenda).set({ status: "refunded" }).where(eq(pedidosVenda.id, pedidoId))
    await this.db.update(assinaturas).set({ status: "reembolsavel" }).where(eq(assinaturas.id, row.assinatura.id))
    await this.db.update(provisionamentoPendente).set({ status: "dead", proximaTentativaEm: null }).where(eq(provisionamentoPendente.id, row.outbox.id))
    return { assinaturaId: row.assinatura.id, outboxId: row.outbox.id }
  }

  marcarReembolsavel(assinaturaId: number): Promise<void> { return this.db.update(assinaturas).set({ status: "reembolsavel" }).where(eq(assinaturas.id, assinaturaId)).then(() => undefined) }
  marcarNegocio(negocioId: number, status: "provisionando" | "provisionado" | "falho"): Promise<void> { return this.db.update(negocios).set({ status }).where(eq(negocios.id, negocioId)).then(() => undefined) }
}
