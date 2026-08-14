/**
 * Conexão Drizzle com o database core (PoC §6.1 — database/core).
 * A fábrica de conexões por projeto (etapa 5) viverá em database/projects.
 */
import {
  Global,
  Inject,
  Module,
  OnModuleDestroy,
} from "@nestjs/common"
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2"
import mysql, { type Pool } from "mysql2/promise"
import * as schema from "../../../../database/schema"
import { EnvService } from "../config/env.service"

export const CORE_POOL = Symbol("CORE_POOL")
export const CORE_DB = Symbol("CORE_DB")

export type CoreDb = MySql2Database<typeof schema>

@Global()
@Module({
  providers: [
    {
      provide: CORE_POOL,
      inject: [EnvService],
      useFactory: (env: EnvService): Pool =>
        mysql.createPool({
          host: env.mysqlHost,
          port: env.mysqlPort,
          user: env.mysqlUser,
          password: env.mysqlPassword,
          database: env.mysqlDatabase,
          connectionLimit: 5,
          waitForConnections: true,
        }),
    },
    {
      provide: CORE_DB,
      inject: [CORE_POOL],
      useFactory: (pool: Pool): CoreDb =>
        drizzle(pool, { schema, mode: "default" }),
    },
  ],
  exports: [CORE_DB, CORE_POOL],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(CORE_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end()
  }
}
