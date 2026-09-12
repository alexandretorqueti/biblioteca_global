import { describe, expect, it } from "vitest"
import { formatDeveloperClarificationContext } from "../src/workers/TaskWorker.js"

describe("contexto de esclarecimento para DEV", () => {
  it("leva pergunta e resposta do chat ao próximo prompt", () => {
    const context = formatDeveloperClarificationContext([
      { role: "analyst", texto: "O desenvolvedor precisa de esclarecimentos.\n1) Qual banco?", createdAt: "" },
      { role: "user", texto: "Use o banco resolvido pelo Motor e não peça credenciais.", createdAt: "" },
    ])
    expect(context).toContain("Qual banco?")
    expect(context).toContain("não peça credenciais")
  })
})
