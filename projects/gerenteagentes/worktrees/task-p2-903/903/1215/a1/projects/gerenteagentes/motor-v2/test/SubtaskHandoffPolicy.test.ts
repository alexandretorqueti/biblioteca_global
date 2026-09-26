import { describe, expect, it } from "vitest"
import { formatPriorSubtaskHandoff, parseGitNameStatus } from "../src/policies/SubtaskHandoffPolicy.js"

describe("SubtaskHandoffPolicy", () => {
  it("aceita apenas caminhos relativos confirmados pelo Git", () => {
    expect(parseGitNameStatus("A\tdocs/CONTRATO.md\nM\tsrc/a.ts\nA\t../../segredo\nX\tignorar.txt\nM\tsrc/a.ts")).toEqual([
      { status: "A", path: "docs/CONTRATO.md" }, { status: "M", path: "src/a.ts" },
    ])
  })

  it("monta contexto objetivo com arquivos e resumo anterior", () => {
    const text = formatPriorSubtaskHandoff([{ seq: 1, title: "Documentar contrato", commit: "abcdef1234567890", summary: "Contrato de permissões", files: [{ status: "A", path: "docs/CONTRATO.md" }] }])
    expect(text).toContain("CONFIRMADO")
    expect(text).toContain("docs/CONTRATO.md")
    expect(text).toContain("Contrato de permissões")
  })
})
