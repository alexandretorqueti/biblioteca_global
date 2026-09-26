/**
 * Config do drizzle-kit do projeto documentacao — migrations ISOLADAS por
 * projeto (PoC §4.3: um projeto nunca afeta a migration de outro).
 */
import { join } from "node:path"
import { defineConfig } from "drizzle-kit"

const aqui = __dirname

export default defineConfig({
  dialect: "mysql",
  schema: join(aqui, "schema.ts"),
  out: join(aqui, "migrations"),
  // dbCredentials vêm do ambiente no momento do migrate:
  // database = projeto_<id do documentacao> (resolvido pelo provisionador).
})
