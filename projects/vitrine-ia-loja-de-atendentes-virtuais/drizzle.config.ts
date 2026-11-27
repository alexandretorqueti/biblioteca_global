/**
 * Config do drizzle-kit do projeto vitrine-ia-loja-de-atendentes-virtuais.
 *
 * Caminhos RELATIVOS ao CWD (raiz do repo, onde os scripts npm rodam):
 * o drizzle-kit 0.31.x faz join(cwd, out/schema) e quebra com caminho
 * absoluto — mesma lição aplicada em database/drizzle.config.ts,
 * projects/gerenteagentes/drizzle.config.ts,
 * projects/gestao-de-tarefas-global/drizzle.config.ts,
 * projects/voz-na-isa/drizzle.config.ts e
 * projects/calculadora-de-investimentos-gabriel/drizzle.config.ts.
 *
 * dbCredentials vêm do ambiente no momento do migrate
 * (MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD ou override via .env da
 * raiz com database=projeto_8509 — id do projeto provisionado, resolvido
 * pelo provisionador; nunca senha em texto no arquivo versionado).
 */
import { defineConfig } from "drizzle-kit"

const vitrineIaDatabase =
  process.env.VITRINE_IA_DATABASE ?? "projeto_8509"

export default defineConfig({
  dialect: "mysql",
  schema: "projects/vitrine-ia-loja-de-atendentes-virtuais/schema.ts",
  out: "projects/vitrine-ia-loja-de-atendentes-virtuais/migrations",
  dbCredentials: {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3308,
    user: process.env.MYSQL_USER || "biblioteca",
    password: process.env.MYSQL_PASSWORD || "",
    database: vitrineIaDatabase,
  },
})
