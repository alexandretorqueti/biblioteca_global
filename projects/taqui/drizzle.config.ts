/**
 * Config do drizzle-kit do projeto taqui.
 * Gera/aplica migrations SQL em projects/taqui/migrations/ a partir de schema.ts.
 */
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "mysql",
  schema: "./schema.ts",
  out: "./migrations",
  dbCredentials: {
    host: "host.docker.internal",
    port: 3308,
    user: "biblioteca",
    password: "llKDXRLuX5hhFwQuIYvAmcCf",
    database: "projeto_6611",
  },
})
