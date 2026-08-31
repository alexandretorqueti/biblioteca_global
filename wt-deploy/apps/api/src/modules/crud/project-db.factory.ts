/**
 * Fábrica de conexões por projeto (PoC §6.1 database/projects):
 * cache por projetoId; o database é SEMPRE derivado do id do projeto do
 * token — impossível alcançar outro database trocando payload.
 */
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common"
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2"
import mysql, { type Pool } from "mysql2/promise"
import { EnvService } from "../../config/env.service"
import { nomeDatabaseDoProjeto } from "../projetos/projetos.service"

export type ProjetoDb = MySql2Database

export interface ConexaoProjeto {
  db: ProjetoDb
  fechar(): Promise<void>
}

/** Injetável para testes unitários (fake sem MySQL real). */
export type ConectorProjeto = (database: string) => Promise<ConexaoProjeto>

export const CONECTOR_PROJETO = Symbol("CONECTOR_PROJETO")
export const PROJECT_DB_FACTORY = Symbol("PROJECT_DB_FACTORY")

/** Conector padrão: pool mysql2 apontando para o database do projeto. */
export function criarConectorPadrao(env: EnvService): ConectorProjeto {
  return async (database: string): Promise<ConexaoProjeto> => {
    const pool: Pool = mysql.createPool({
      host: env.mysqlHost,
      port: env.mysqlPort,
      user: env.mysqlUser,
      password: env.mysqlPassword,
      database,
      connectionLimit: 3,
      waitForConnections: true,
    })
    return {
      db: drizzle(pool, { mode: "default" }),
      fechar: () => pool.end(),
    }
  }
}

@Injectable()
export class ProjectDbFactory implements OnModuleDestroy {
  private readonly cache = new Map<number, ConexaoProjeto>()

  constructor(
    @Inject(CONECTOR_PROJETO) private readonly conector: ConectorProjeto,
  ) {}

  async obter(projeto: { id: number }): Promise<ProjetoDb> {
    const existente = this.cache.get(projeto.id)
    if (existente) return existente.db

    // Nome derivado do id — nunca do input do cliente.
    const database = nomeDatabaseDoProjeto(projeto.id)
    const conexao = await this.conector(database)
    this.cache.set(projeto.id, conexao)
    return conexao.db
  }

  async onModuleDestroy(): Promise<void> {
    for (const conexao of this.cache.values()) {
      await conexao.fechar().catch(() => undefined)
    }
    this.cache.clear()
  }
}
