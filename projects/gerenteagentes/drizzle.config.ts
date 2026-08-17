/**
 * Config do drizzle-kit do projeto gerenteagentes.
 *
 * Caminhos RELATIVOS ao CWD (raiz do repo, onde os scripts npm rodam):
 * o drizzle-kit 0.31.10 faz join(cwd, out/schema) e quebra com caminho
 * absoluto — na segunda geração ele tenta ler ".//data/.../meta/0000_snapshot.json"
 * (ENOENT). Mesma correção já aplicada em database/drizzle.config.ts.
 */
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "mysql",
  schema: "projects/gerenteagentes/schema.ts",
  out: "projects/gerenteagentes/migrations",
})
