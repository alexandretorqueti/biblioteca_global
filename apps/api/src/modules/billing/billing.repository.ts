import { Inject, Injectable } from "@nestjs/common"
import { and, asc, eq, lte, or, sql } from "drizzle-orm"
import { assinaturas, billingWebhookEvents, planosProduto, provisionamentoPendente } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export const BILLING_REPOSITORY = Symbol("BILLING_REPOSITORY")

export type PlanoProduto = typeof planosProduto.$inferSelect
export type Assinatura = typeof assinaturas.$inferSelect
export type BillingWebhookEvent = typeof billingWebhookEvents.$inferSelect

export interface BillingRepository {
  listarPlanosAtivos(): Promise<PlanoProduto[]>
  buscarPlanoAtivo(slug: string): Promise<PlanoProduto | undefined>
  criarAssinatura(input: {
    tenantSlug: string
    planoProdutoId: number
    ciclo: "monthly" | "yearly"
  }): Promise<Assinatura>
  vincularPsp(assinaturaId: number, customerId: string, subscriptionId: string): Promise<void>
  inserirWebhook(input: { dedupeKey: string; tipo: string; payload: unknown }): Promise<{ event: BillingWebhookEvent; duplicate: boolean }>
  claimWebhook(id: number): Promise<BillingWebhookEvent | undefined>
  marcarWebhookConcluido(id: number): Promise<void>
  marcarWebhookFalho(id: number, error: string): Promise<void>
  processarAprovacao(input: { subscriptionId: string; payload: unknown }): Promise<void>
}

@Injectable()
export class DrizzleBillingRepository implements BillingRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  listarPlanosAtivos(): Promise<PlanoProduto[]> {
    return this.db.select().from(planosProduto)
      .where(eq(planosProduto.ativo, true))
      .orderBy(asc(planosProduto.precoCentavos))
  }

  async buscarPlanoAtivo(slug: string): Promise<PlanoProduto | undefined> {
    const [plano] = await this.db.select().from(planosProduto)
      .where(and(eq(planosProduto.slug, slug), eq(planosProduto.ativo, true)))
      .limit(1)
    return plano
  }

  async criarAssinatura(input: {
    tenantSlug: string
    planoProdutoId: number
    ciclo: "monthly" | "yearly"
  }): Promise<Assinatura> {
    const [inserted] = await this.db.insert(assinaturas).values({
      tenantSlug: input.tenantSlug,
      planoProdutoId: input.planoProdutoId,
      ciclo: input.ciclo,
      status: "pending",
    }).$returningId()
    if (!inserted) throw new Error("Falha ao criar assinatura")
    const [row] = await this.db.select().from(assinaturas)
      .where(eq(assinaturas.id, inserted.id)).limit(1)
    if (!row) throw new Error("Assinatura não encontrada após criação")
    return row
  }

  async vincularPsp(assinaturaId: number, customerId: string, subscriptionId: string): Promise<void> {
    await this.db.update(assinaturas).set({
      pspCustomerId: customerId,
      pspSubscriptionId: subscriptionId,
    }).where(eq(assinaturas.id, assinaturaId))
  }

  async inserirWebhook(input: { dedupeKey: string; tipo: string; payload: unknown }): Promise<{ event: BillingWebhookEvent; duplicate: boolean }> {
    const [insertResult] = await this.db.insert(billingWebhookEvents).values({
      dedupeKey: input.dedupeKey,
      tipo: input.tipo,
      payload: input.payload,
      status: "pending",
    }).onDuplicateKeyUpdate({ set: { dedupeKey: input.dedupeKey } })
    const [event] = await this.db.select().from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.dedupeKey, input.dedupeKey)).limit(1)
    if (!event) throw new Error("Evento de webhook não encontrado após persistência")
    return { event, duplicate: insertResult.affectedRows !== 1 }
  }

  async claimWebhook(id: number): Promise<BillingWebhookEvent | undefined> {
    const result = await this.db.update(billingWebhookEvents).set({
      status: "processing",
      tentativas: sql`${billingWebhookEvents.tentativas} + 1`,
    }).where(and(
      eq(billingWebhookEvents.id, id),
      or(
        eq(billingWebhookEvents.status, "pending"),
        and(eq(billingWebhookEvents.status, "failed"), or(
          lte(billingWebhookEvents.proximaTentativaEm, new Date()),
          sql`${billingWebhookEvents.proximaTentativaEm} IS NULL`,
        )),
      ),
    ))
    if (result[0].affectedRows !== 1) return undefined
    const [event] = await this.db.select().from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.id, id)).limit(1)
    return event
  }

  marcarWebhookConcluido(id: number): Promise<void> {
    return this.db.update(billingWebhookEvents).set({ status: "done", proximaTentativaEm: null })
      .where(and(eq(billingWebhookEvents.id, id), eq(billingWebhookEvents.status, "processing"))).then(() => undefined)
  }

  marcarWebhookFalho(id: number): Promise<void> {
    return this.db.update(billingWebhookEvents).set({
      status: "failed",
      proximaTentativaEm: new Date(Date.now() + 60_000),
    }).where(and(eq(billingWebhookEvents.id, id), eq(billingWebhookEvents.status, "processing"))).then(() => undefined)
  }

  async processarAprovacao(input: { subscriptionId: string; payload: unknown }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [assinatura] = await tx.select().from(assinaturas)
        .where(eq(assinaturas.pspSubscriptionId, input.subscriptionId)).limit(1)
      if (!assinatura || assinatura.status !== "pending") return
      await tx.update(assinaturas).set({ status: "active" })
        .where(and(eq(assinaturas.id, assinatura.id), eq(assinaturas.status, "pending")))
      await tx.insert(provisionamentoPendente).values({
        assinaturaId: assinatura.id,
        tipo: "billing.provision",
        payload: input.payload,
        ciclo: assinatura.ciclo,
        status: "pending",
      }).onDuplicateKeyUpdate({ set: { assinaturaId: assinatura.id } })
    })
  }
}
