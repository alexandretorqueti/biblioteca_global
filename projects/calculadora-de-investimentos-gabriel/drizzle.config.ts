/**
 * Config do drizzle-kit do projeto calculadora-de-investimentos-gabriel.
 *
 * Caminhos RELATIVOS ao CWD (raiz do repo, onde os scripts npm rodam):
 * o drizzle-kit 0.31.10 faz join(cwd, out/schema) e quebra com caminho
 * absoluto — mesma lição aplicada em database/drizzle.config.ts,
 * projects/gerenteagentes/drizzle.config.ts,
 * projects/gestao-de-tarefas-global/drizzle.config.ts e
 * projects/voz-na-isa/drizzle.config.ts.
 *
 * dbCredentials vêm do ambiente no momento do migrate
 * (MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD ou override via .env da
 * raiz com database=projeto_8499 — id do projeto provisionado no subtask 1,
 * resolvido pelo provisionador; nunca senha em texto no arquivo versionado).
 */
import { defineConfig } from "drizzle-kit"

const calculadoraGabrielDatabase =
  process.env.CALCULADORA_GABRIEL_DATABASE ?? "projeto_8499"

export default defineConfig({
  dialect: "mysql",
  schema: "projects/calculadora-de-investimentos-gabriel/schema.ts",
  out: "projects/calculadora-de-investimentos-gabriel/migrations",
  dbCredentials: {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3308,
    user: process.env.MYSQL_USER || "biblioteca",
    password: process.env.MYSQL_PASSWORD || "",
    database: calculadoraGabrielDatabase,
  },
})
