/**
 * Config do drizzle-kit para o database core.
 * Gera/aplica migrations SQL em database/migrations/ a partir de schema.ts.
 * Caminhos absolutos — os scripts rodam da raiz, mas o drizzle-kit resolve
 * schema/out relativos ao CWD, não ao arquivo de config.
 */
import { defineConfig } from "drizzle-kit"
import { loadEnv } from "./env.js"

// Caminhos RELATIVOS ao CWD (raiz do repo, onde os scripts npm rodam):
// o drizzle-kit 0.31.10 faz join(cwd, out/schema) e quebra com caminho
// absoluto (vira ".//data/..." → ENOENT no snapshot).
const env = loadEnv()

export default defineConfig({
  dialect: "mysql",
  schema: "database/schema.ts",
  out: "database/migrations",
  dbCredentials: {
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  },
})
