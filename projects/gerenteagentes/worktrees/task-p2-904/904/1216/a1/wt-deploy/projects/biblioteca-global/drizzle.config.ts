/**
 * Config do drizzle-kit do projeto biblioteca-global. Sem tabelas de
 * negócio por enquanto — migrations ficam vazias até o projeto precisar
 * de modelo próprio (PoC §9.1).
 */
import { join } from "node:path"
import { defineConfig } from "drizzle-kit"

const aqui = __dirname

export default defineConfig({
  dialect: "mysql",
  schema: join(aqui, "schema.ts"),
  out: join(aqui, "migrations"),
})
