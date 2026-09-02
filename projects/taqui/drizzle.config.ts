/**
 * Config do drizzle-kit do projeto taqui.
 * Gera/aplica migrations SQL em projects/taqui/migrations/ a partir de schema.ts.
 */
import { join } from "node:path"
import { defineConfig } from "drizzle-kit"

const aqui = __dirname

export default defineConfig({
  dialect: "mysql",
  schema: join(aqui, "schema.ts"),
  out: join(aqui, "migrations"),
  dbCredentials: {
    host: "host.docker.internal",
    port: 3308,
    user: "biblioteca",
    password: "llKDXRLuX5hhFwQuIYvAmcCf",
    database: "projeto_6611",
  },
})
