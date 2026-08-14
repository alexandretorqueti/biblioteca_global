/**
 * Config do drizzle-kit para o database core.
 * Gera/aplica migrations SQL em database/migrations/ a partir de schema.ts.
 * Caminhos absolutos (via import.meta.url) — os scripts rodam da raiz, mas o
 * drizzle-kit resolve schema/out relativos ao CWD, não ao arquivo de config.
 */
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "drizzle-kit"
import { loadEnv } from "./env.js"

const aqui = dirname(fileURLToPath(import.meta.url))
const env = loadEnv()

export default defineConfig({
  dialect: "mysql",
  schema: join(aqui, "schema.ts"),
  out: join(aqui, "migrations"),
  dbCredentials: {
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  },
})
