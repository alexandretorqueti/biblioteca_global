/**
 * Provisionador de projetos (PoC §6.3 — ciclo de vida):
 * CREATE DATABASE projeto_<id> + grants para o usuário da aplicação +
 * migrations da pasta projects/<slug>/migrations/.
 *
 * Usa credenciais root SOMENTE para DDL; o runtime continua com o usuário
 * limitado. Nome de database é gerado pelo sistema (whitelist, nunca input).
 */
import { Inject, Injectable } from "@nestjs/common"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { migrate } from "drizzle-orm/mysql2/migrator"
import { drizzle } from "drizzle-orm/mysql2"
import mysql from "mysql2/promise"
import { EnvService } from "../../config/env.service"

export interface ProjetoProvisioner {
  /** Cria o database e concede acesso ao usuário da aplicação. */
  prepararDatabase(database: string): Promise<void>
  /** Aplica as migrations da pasta do projeto; devolve quantas aplicou. */
  aplicarMigrations(slug: string, database: string): Promise<number>
  /** Remove o database (compensação/best-effort). */
  removerDatabase(database: string): Promise<void>
}

export const PROJETO_PROVISIONER = Symbol("PROJETO_PROVISIONER")

/** Nome de database é sempre `projeto_<id>` — validação defensiva. */
export function validarNomeDatabase(database: string): void {
  if (!/^projeto_[0-9]+$/.test(database)) {
    throw new Error(`nome de database inválido: ${database}`)
  }
}

export function validarSlug(slug: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(`slug inválido: ${slug}`)
  }
}

@Injectable()
export class DrizzleProjetoProvisioner implements ProjetoProvisioner {
  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  /** Raiz do repositório (este arquivo: apps/api/src/modules/projetos). */
  private get raizRepo(): string {
    return resolve(__dirname, "..", "..", "..", "..", "..")
  }

  private async conexaoRoot(database?: string): Promise<mysql.Connection> {
    return mysql.createConnection({
      host: this.env.mysqlHost,
      port: this.env.mysqlPort,
      user: "root",
      password: this.env.mysqlRootPassword,
      database,
    })
  }

  async prepararDatabase(database: string): Promise<void> {
    validarNomeDatabase(database)
    // Usuário vem do .env (config confiável); remove caracteres de quoting.
    const usuario = this.env.mysqlUser.replace(/[`'\\]/g, "")
    const conexao = await this.conexaoRoot()
    try {
      await conexao.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``)
      await conexao.query(
        `GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${usuario}'@'%'`,
      )
      await conexao.query("FLUSH PRIVILEGES")
    } finally {
      await conexao.end()
    }
  }

  async aplicarMigrations(slug: string, database: string): Promise<number> {
    validarSlug(slug)
    validarNomeDatabase(database)
    const pasta = resolve(this.raizRepo, "projects", slug, "migrations")
    const journal = resolve(pasta, "meta", "_journal.json")
    if (!existsSync(journal)) {
      // Pasta ausente ou sem migrations geradas — nada a aplicar.
      return 0
    }

    const conexao = await this.conexaoRoot(database)
    try {
      const db = drizzle(conexao)
      await migrate(db, { migrationsFolder: pasta })
      const [linhas] = await conexao.query(
        "SELECT COUNT(*) AS total FROM __drizzle_migrations",
      )
      const primeira = (linhas as Array<{ total: number }>).at(0)
      return Number(primeira?.total ?? 0)
    } finally {
      await conexao.end()
    }
  }

  async removerDatabase(database: string): Promise<void> {
    validarNomeDatabase(database)
    const conexao = await this.conexaoRoot()
    try {
      await conexao.query(`DROP DATABASE IF EXISTS \`${database}\``)
    } finally {
      await conexao.end()
    }
  }
}
