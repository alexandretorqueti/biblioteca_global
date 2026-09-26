import { defineConfig, devices } from "@playwright/test"

/**
 * Configuração mínima de Playwright para a Biblioteca Global.
 *
 * - `baseURL` aponta para o servidor Vite que será iniciado manualmente
 *   (ex.: `npm run dev` em outra janela).  Em CI, um script pode iniciar o
 *   preview (`vite preview`) antes de rodar os testes.
 * - Usa apenas Chromium para reduzir dependências; outros browsers podem ser
 *   adicionados posteriormente.
 */

export default defineConfig({
  testDir: "apps/web/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
    browserName: "chromium",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})

