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
  marcarWebhookFalho(id: number, error: string, proximaTentativaEm: Date): Promise<void>
  marcarWebhookDead(id: number): Promise<void>
  listarWebhooksParaRetry(agora: Date, limite: number): Promise<BillingWebhookEvent[]>
  listarAssinaturasPendentesAntigas(antesDe: Date, limite: number): Promise<Assinatura[]>
  marcarAssinaturaReembolsavel(pspSubscriptionId: string): Promise<void>
  sincronizarAssinaturaPsp(input: { subscriptionId: string; status: string; payload: unknown }): Promise<void>
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

  marcarWebhookFalho(id: number, error: string, proximaTentativaEm: Date): Promise<void> {
    return this.db.update(billingWebhookEvents).set({
      status: "failed",
      proximaTentativaEm,
    }).where(and(eq(billingWebhookEvents.id, id), or(eq(billingWebhookEvents.status, "processing"), eq(billingWebhookEvents.status, "failed")))).then(() => undefined)
  }

  marcarWebhookDead(id: number): Promise<void> {
    return this.db.update(billingWebhookEvents).set({
      status: "dead",
      proximaTentativaEm: null,
    }).where(and(eq(billingWebhookEvents.id, id), or(eq(billingWebhookEvents.status, "processing"), eq(billingWebhookEvents.status, "failed")))).then(() => undefined)
  }

  listarWebhooksParaRetry(agora: Date, limite: number): Promise<BillingWebhookEvent[]> {
    return this.db.select().from(billingWebhookEvents)
      .where(and(
        or(eq(billingWebhookEvents.status, "pending"), eq(billingWebhookEvents.status, "failed")),
        or(lte(billingWebhookEvents.proximaTentativaEm, agora), sql`${billingWebhookEvents.proximaTentativaEm} IS NULL`),
      ))
      .orderBy(asc(billingWebhookEvents.id)).limit(limite)
  }

  listarAssinaturasPendentesAntigas(antesDe: Date, limite: number): Promise<Assinatura[]> {
    return this.db.select().from(assinaturas)
      .where(and(eq(assinaturas.status, "pending"), lte(assinaturas.createdAt, antesDe)))
      .orderBy(asc(assinaturas.id)).limit(limite)
  }

  async marcarAssinaturaReembolsavel(pspSubscriptionId: string): Promise<void> {
    await this.db.update(assinaturas).set({ status: "reembolsavel" })
      .where(and(eq(assinaturas.pspSubscriptionId, pspSubscriptionId), or(eq(assinaturas.status, "active"), eq(assinaturas.status, "pending"))))
  }

  async sincronizarAssinaturaPsp(input: { subscriptionId: string; status: string; payload: unknown }): Promise<void> {
    const status = input.status.toLowerCase()
    if (["approved", "authorized", "active", "authorized_payment"].includes(status)) {
      await this.processarAprovacao({ subscriptionId: input.subscriptionId, payload: input.payload })
      return
    }
    const localStatus = status.includes("cancel") ? "canceled" : status.includes("past") || status.includes("fail") ? "past_due" : undefined
    if (localStatus) {
      await this.db.update(assinaturas).set({ status: localStatus })
        .where(and(eq(assinaturas.pspSubscriptionId, input.subscriptionId), eq(assinaturas.status, "pending")))
    }
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
