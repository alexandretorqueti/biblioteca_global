import { describe, expect, it } from "vitest"
import { assertCleanGitEvidence } from "../src/workers/TaskWorker.js"

describe("gate de evidência Git", () => {
  it("aceita um worktree sem qualquer saída do status porcelain", () => {
    expect(() => assertCleanGitEvidence("\n")).not.toThrow()
  })

  it("reprova alterações rastreadas, staged e não rastreadas remanescentes", () => {
    expect(() => assertCleanGitEvidence(" M src/tela.tsx\n?? artefato.log\n")).toThrow(
      "worktree não ficou integralmente limpo",
    )
  })
})
