import { defineConfig } from "vitest/config"

/**
 * Testes unitários do monorepo.
 * biblioteca_old/ é referência da v1 — seus testes foram PORTADOS para
 * packages/ui na Etapa 8 (utils + componentes com jsdom).
 */
export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "biblioteca_old/**"],
    // Cleanup automático do @testing-library/react entre testes.
    globals: true,
    // O container roda NODE_ENV=production; o build production do React
    // não exporta `act` (exigido pelo @testing-library/react).
    env: { NODE_ENV: "test" },
    // Testes funcionais (etapa 3+) usam MySQL real + argon2.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
