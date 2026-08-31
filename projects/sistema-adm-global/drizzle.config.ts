import { join } from "node:path"
import { defineConfig } from "drizzle-kit"

const aqui = __dirname

export default defineConfig({
  dialect: "mysql",
  schema: join(aqui, "schema.ts"),
  out: join(aqui, "migrations"),
})
