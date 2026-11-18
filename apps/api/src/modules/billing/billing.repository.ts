import { Inject, Injectable } from "@nestjs/common"
import { and, asc, eq } from "drizzle-orm"
import { assinaturas, planosProduto } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export const BILLING_REPOSITORY = Symbol("BILLING_REPOSITORY")

export type PlanoProduto = typeof planosProduto.$inferSelect
export type Assinatura = typeof assinaturas.$inferSelect

export interface BillingRepository {
  listarPlanosAtivos(): Promise<PlanoProduto[]>
  buscarPlanoAtivo(slug: string): Promise<PlanoProduto | undefined>
  criarAssinatura(input: {
    tenantSlug: string
    planoProdutoId: number
    ciclo: "monthly" | "yearly"
  }): Promise<Assinatura>
  vincularPsp(assinaturaId: number, customerId: string, subscriptionId: string): Promise<void>
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
}
