import { Inject, Injectable } from "@nestjs/common"
import { and, eq, lt } from "drizzle-orm"
import { logsAcessoDadosSensiveis, usuarios } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export interface RetencaoRepository {
  encontrarInativosAntesDe(data: Date): Promise<number[]>
  desativarPorRetencao(usuarioId: number): Promise<void>
}

export const RETENCAO_REPOSITORY = Symbol("RETENCAO_REPOSITORY")

@Injectable()
export class DrizzleRetencaoRepository implements RetencaoRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async encontrarInativosAntesDe(data: Date): Promise<number[]> {
    const linhas = await this.db
      .select({ id: usuarios.id })
      .from(usuarios)
      .where(and(eq(usuarios.ativo, true), lt(usuarios.updatedAt, data)))
    return linhas.map((linha) => linha.id)
  }

  async desativarPorRetencao(usuarioId: number): Promise<void> {
    await this.db
      .update(usuarios)
      .set({ ativo: false })
      .where(eq(usuarios.id, usuarioId))
    await this.db.insert(logsAcessoDadosSensiveis).values({
      usuarioId,
      tipoDado: "dados_pessoais",
      acao: "retencao_desativacao",
      ip: null,
    })
  }
}
