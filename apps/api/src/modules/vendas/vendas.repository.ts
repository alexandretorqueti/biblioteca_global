import { Inject, Injectable } from "@nestjs/common"
import { and, desc, eq } from "drizzle-orm"
import { negocioDocumentos, negocios, pedidosVenda } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export const VENDAS_REPOSITORY = Symbol("VENDAS_REPOSITORY")
export type Negocio = typeof negocios.$inferSelect
export type NegocioDocumento = typeof negocioDocumentos.$inferSelect
export type PedidoVenda = typeof pedidosVenda.$inferSelect

export interface VendasRepository {
  upsertNegocio(input: {
    chatId: string
    nome: string
    segmentoDescricao: string
    contato: object
    transbordo: object
  }): Promise<Negocio>
  buscarNegocioPorChatId(chatId: string): Promise<Negocio | undefined>
  criarDocumento(input: {
    negocioId: number
    nome: string
    mime: string
    tamanho: number
    caminho: string
  }): Promise<NegocioDocumento>
  listarDocumentos?(negocioId: number): Promise<NegocioDocumento[]>
  buscarPedidoPendente?(negocioId: number): Promise<PedidoVenda | undefined>
  invalidarPedido?(pedidoId: number): Promise<void>
  criarPedido?(input: {
    negocioId: number
    planoSlug: string
    payloadSnapshot: object
  }): Promise<PedidoVenda>
  vincularPedidoAssinatura?(pedidoId: number, assinaturaId: number, checkoutUrl: string): Promise<PedidoVenda>
  atualizarStatusNegocio?(negocioId: number, status: "aguardando_plano" | "checkout"): Promise<void>
}

@Injectable()
export class DrizzleVendasRepository implements VendasRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async upsertNegocio(input: Parameters<VendasRepository["upsertNegocio"]>[0]): Promise<Negocio> {
    await this.db.insert(negocios).values({ ...input, status: "capturado" }).onDuplicateKeyUpdate({
      set: {
        nome: input.nome,
        segmentoDescricao: input.segmentoDescricao,
        contato: input.contato,
        transbordo: input.transbordo,
      },
    })
    const row = await this.buscarNegocioPorChatId(input.chatId)
    if (!row) throw new Error("Negócio não encontrado após persistência")
    return row
  }

  async buscarNegocioPorChatId(chatId: string): Promise<Negocio | undefined> {
    const [row] = await this.db.select().from(negocios).where(eq(negocios.chatId, chatId)).limit(1)
    return row
  }

  async criarDocumento(input: Parameters<VendasRepository["criarDocumento"]>[0]): Promise<NegocioDocumento> {
    const [inserted] = await this.db.insert(negocioDocumentos).values(input).$returningId()
    if (!inserted) throw new Error("Falha ao criar documento do negócio")
    const [row] = await this.db.select().from(negocioDocumentos).where(eq(negocioDocumentos.id, inserted.id)).limit(1)
    if (!row) throw new Error("Documento não encontrado após persistência")
    return row
  }

  listarDocumentos(negocioId: number): Promise<NegocioDocumento[]> {
    return this.db.select().from(negocioDocumentos).where(eq(negocioDocumentos.negocioId, negocioId))
  }

  async buscarPedidoPendente(negocioId: number): Promise<PedidoVenda | undefined> {
    const [row] = await this.db.select().from(pedidosVenda)
      .where(and(eq(pedidosVenda.negocioId, negocioId), eq(pedidosVenda.status, "pending")))
      .orderBy(desc(pedidosVenda.id)).limit(1)
    return row
  }

  async invalidarPedido(pedidoId: number): Promise<void> {
    await this.db.update(pedidosVenda).set({ status: "failed" }).where(eq(pedidosVenda.id, pedidoId))
  }

  async criarPedido(input: Parameters<NonNullable<VendasRepository["criarPedido"]>>[0]): Promise<PedidoVenda> {
    const [inserted] = await this.db.insert(pedidosVenda).values(input).$returningId()
    if (!inserted) throw new Error("Falha ao criar pedido de venda")
    const [row] = await this.db.select().from(pedidosVenda).where(eq(pedidosVenda.id, inserted.id)).limit(1)
    if (!row) throw new Error("Pedido não encontrado após persistência")
    return row
  }

  async vincularPedidoAssinatura(pedidoId: number, assinaturaId: number, checkoutUrl: string): Promise<PedidoVenda> {
    await this.db.update(pedidosVenda).set({ assinaturaId, checkoutUrl, status: "pending" }).where(eq(pedidosVenda.id, pedidoId))
    const [row] = await this.db.select().from(pedidosVenda).where(eq(pedidosVenda.id, pedidoId)).limit(1)
    if (!row) throw new Error("Pedido não encontrado após vínculo")
    return row
  }

  atualizarStatusNegocio(negocioId: number, status: "aguardando_plano" | "checkout"): Promise<void> {
    return this.db.update(negocios).set({ status }).where(eq(negocios.id, negocioId)).then(() => undefined)
  }
}
