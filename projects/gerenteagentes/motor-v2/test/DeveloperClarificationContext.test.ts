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

  it("envia apenas o último checkpoint respondido", () => {
    const context = formatDeveloperClarificationContext([
      { role: "analyst", texto: "1) Primeira pergunta?", createdAt: "" },
      { role: "user", texto: "Primeira resposta", createdAt: "" },
      { role: "analyst", texto: "1) Segunda pergunta?", createdAt: "" },
      { role: "user", texto: "Segunda resposta", createdAt: "" },
    ])
    expect(context).toContain("Segunda pergunta?")
    expect(context).toContain("Segunda resposta")
    expect(context).not.toContain("Primeira pergunta?")
    expect(context).not.toContain("Primeira resposta")
  })
})
