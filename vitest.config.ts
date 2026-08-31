import { defineConfig } from "vitest/config"

/**
 * Testes unitários do monorepo.
 * biblioteca_old/ é referência da v1 — seus testes foram PORTADOS para
 * packages/ui na Etapa 8 (utils + componentes com jsdom).
 * e2e/ contém specs Playwright (rodados via playwright.config.ts do root),
 * que não pertencem ao vitest — excluídos daqui.
 * wt-deploy/ é cópia de worktree de deploy commitada — testes duplicados,
 * excluídos para não rodar (nem quebrar) a suíte em dobro (2026-08-31).
 */
export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "biblioteca_old/**", "**/e2e/**", "wt-deploy/**", "**/motor-v2/**"],
    // Cleanup automático do @testing-library/react entre testes.
    globals: true,
    // O container roda NODE_ENV=production; o build production do React
    // não exporta `act` (exigido pelo @testing-library/react).
    env: { NODE_ENV: "test", TZ: "UTC" },
    // Environment jsdom para testes de componentes React.
    // Testes de backend (apps/api, database) declaram `// @vitest-environment node`
    // por arquivo: jsdom externaliza builtins Node e o Vitest 4.1.10 quebra com
    // "No such built-in module: node:" (ERR_UNKNOWN_BUILTIN_MODULE).
    environment: "jsdom",
    // Testes funcionais (etapa 3+) usam MySQL real + argon2.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
