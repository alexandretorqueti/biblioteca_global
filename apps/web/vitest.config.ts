/**
 * Vitest — apps/web (Etapa 9).
 * Ambiente jsdom para testes de componente (AuthPanel login) e node para
 * a lógica pura de renovação de token.
 */
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    env: { NODE_ENV: "test" },
  },
})
