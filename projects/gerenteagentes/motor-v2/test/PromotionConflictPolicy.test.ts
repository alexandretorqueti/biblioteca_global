import { describe, expect, it } from "vitest"
import { evaluatePromotionConflictAnalysis } from "../src/promotion-conflicts/PromotionConflictPolicy.js"

const evidence = {
  taskId: "t", baseBranch: "base", taskBranch: "task", baseCommit: "a".repeat(40), taskCommit: "b".repeat(40),
  mergeBase: "c".repeat(40), fingerprint: "d".repeat(64),
  conflictFiles: [{ path: "a.ts", kind: "semantic" as const, baseExcerpt: "a", taskExcerpt: "b", ancestorExcerpt: "c" }],
}

describe("PromotionConflictPolicy", () => {
  it("aceita JSON cercado por markdown, mas não autoriza merge automático", () => {
    const result = evaluatePromotionConflictAnalysis('relatório\n```json\n{"confidence":"high"}\n```', evidence)
    expect(result).toMatchObject({ confidence: "high", recommendation: "create_resolution_subtask" })
  })

  it("baixa confiança quando o relatório não é estruturado", () => {
    expect(evaluatePromotionConflictAnalysis("texto livre", evidence).confidence).toBe("low")
  })
})

