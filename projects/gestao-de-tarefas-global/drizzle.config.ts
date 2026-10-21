import { join } from "node:path"
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "mysql",
  schema: join(__dirname, "schema.ts"),
  out: join(__dirname, "migrations"),
})
