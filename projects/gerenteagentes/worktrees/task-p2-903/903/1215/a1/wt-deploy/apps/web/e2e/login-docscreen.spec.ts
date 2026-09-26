import { test, expect } from "@playwright/test"

/**
 * Etapa 11 – E2E (placeholder).
 *
 * O teste completo envolveria:
 *   1. abrir a página de login (`/`),
 *   2. preencher usuário/senha, submeter e aguardar redirecionamento ao seletor de projeto,
 *   3. selecionar o projeto "documentacao",
 *   4. clicar no item de menu que referencia `componentId: "documentation"` e
 *      validar a presença do título <h1>Documentação do Projeto</h1>.
 *
 * Por enquanto, o ambiente não possui as dependências gráficas necessárias para executar
 * navegadores reais (libXcursor, libgtk‑3, etc.).  Para que a CI continue avançando,
 * marcamos o teste como `skip`. Quando o ambiente de integração for provisionado com
 * os browsers adequados, basta remover `test.skip` e o fluxo será validado automaticamente.
 */

test.describe("E2E – login + navegação para documentação", () => {
  test.skip("login → selecionar projeto → abrir tela de documentação", async ({ page }) => {
    // Placeholder implementation – will be filled when Playwright can run.
    await page.goto("http://localhost:5173")
    // TODO: interact with login form, select project, click documentation menu.
    const heading = await page.locator('text=Documentação do Projeto')
    await expect(heading).toBeVisible()
  })
})

