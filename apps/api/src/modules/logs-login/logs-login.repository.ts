import { Inject, Injectable } from "@nestjs/common"
import { desc, like, sql } from "drizzle-orm"
import { logsLogin } from "../../../../../database/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"

export type LogLoginListItem = typeof logsLogin.$inferSelect

export interface ListLogsLoginFiltros {
  page: number
  pageSize: number
  search?: string
}

export interface LogsLoginRepository {
  listar(
    filtros: ListLogsLoginFiltros,
  ): Promise<{ items: LogLoginListItem[]; total: number }>
}

export const LOGS_LOGIN_REPOSITORY = Symbol("LOGS_LOGIN_REPOSITORY")

@Injectable()
export class DrizzleLogsLoginRepository implements LogsLoginRepository {
  constructor(@Inject(CORE_DB) private readonly db: CoreDb) {}

  async listar(
    filtros: ListLogsLoginFiltros,
  ): Promise<{ items: LogLoginListItem[]; total: number }> {
    const busca = filtros.search?.trim()
    const onde = busca ? like(logsLogin.email, `%${busca}%`) : undefined
    const total = await this.db
      .select({ quantidade: sql<number>`count(*)` })
      .from(logsLogin)
      .where(onde)
    const items = await this.db
      .select()
      .from(logsLogin)
      .where(onde)
      .orderBy(desc(logsLogin.timestamp))
      .limit(filtros.pageSize)
      .offset((filtros.page - 1) * filtros.pageSize)

    return { items, total: Number(total.at(0)?.quantidade ?? 0) }
  }
}
