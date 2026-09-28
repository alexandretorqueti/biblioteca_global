/**
 * Config do drizzle-kit do projeto gerenteagentes.
 *
 * Caminhos RELATIVOS ao CWD (raiz do repo, onde os scripts npm rodam):
 * o drizzle-kit 0.31.10 faz join(cwd, out/schema) e quebra com caminho
 * absoluto — na segunda geração ele tenta ler ".//data/.../meta/0000_snapshot.json"
 * (ENOENT). Mesma correção já aplicada em database/drizzle.config.ts.
 */
import { defineConfig } from "drizzle-kit"

const gerenteAgentesDatabase = process.env.GERENTE_AGENTES_DATABASE ?? "projeto_640"

export default defineConfig({
  dialect: "mysql",
  schema: "projects/gerenteagentes/schema.ts",
  out: "projects/gerenteagentes/migrations",
  dbCredentials: {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3308,
    user: process.env.MYSQL_USER || "biblioteca",
    password: process.env.MYSQL_PASSWORD || "",
    database: gerenteAgentesDatabase,
  },
})
