import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { validatePremiseRefutation } from "../src/policies/PremiseRefutationPolicy.js"

describe("PremiseRefutationPolicy", () => {
  it("aceita somente evidência verificável dentro do workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "premise-"))
    try {
      await writeFile(join(root, "schema.ts"), "export const users = {}")
      const result = validatePremiseRefutation({ claim: "A coluna projeto_id não existe", conflict_type: "source_of_truth_conflict", evidence: [{ path: "schema.ts", observation: "Tabela users não declara projeto_id" }], suggested_revision: "Adicionar a coluna antes de implementar a consulta" }, root)
      expect(result.ok).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it("rejeita arquivo inexistente", () => {
    expect(validatePremiseRefutation({ claim: "Premissa claramente incorreta", conflict_type: "missing_prerequisite", evidence: [{ path: "nao-existe.ts", observation: "arquivo ausente" }], suggested_revision: "Criar primeiro o pré-requisito necessário" }, "/tmp").ok).toBe(false)
  })
})
