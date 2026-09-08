import { describe, expect, it } from "vitest"
import { composeDevelopmentPrompt } from "../src/prompts/PromptComposition.js"

describe("composição do prompt de desenvolvimento", () => {
  it("expõe as origens e mantém o texto da tabela entre os guardas do Motor", () => {
    const result = composeDevelopmentPrompt(
      "/worktree/a1/projects/gerenteagentes",
      "/worktree/a1",
      "PROMPT DA TABELA",
    )

    expect(result.parts.map((part) => part.source)).toEqual(["system", "table", "system"])
    expect(result.finalText).toContain("resultado esperado de pwd): /worktree/a1/projects/gerenteagentes")
    expect(result.finalText).toContain("git rev-parse --show-toplevel): /worktree/a1")
    expect(result.finalText).toContain("esses caminhos não precisam ser iguais")
    expect(result.finalText).toContain("PROMPT DA TABELA")
    expect(result.finalText.indexOf("PROMPT DA TABELA")).toBeGreaterThan(result.finalText.indexOf("REGRA DE SEGURANÇA"))
    expect(result.finalText).toContain("VERIFICAÇÃO DE SEGURANÇA")
  })
})
