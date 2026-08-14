import { defineConfig } from "vitest/config"

/**
 * Testes unitários do monorepo.
 * biblioteca_old/ é referência da v1 — seus 12 testes serão PORTADOS na
 * Etapa 8 (packages/ui), não rodados do backup.
 */
export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "biblioteca_old/**"],
  },
})
