import { describe, expect, it } from "vitest"
import { defaultChain, formatSessionKey } from "../src/policies/ModelTierPolicy.js"

describe("ModelTierPolicy", () => {
  it("mantém cadeias distintas para análise e desenvolvimento", () => {
    expect(defaultChain("analysis").length).toBeGreaterThan(0)
    expect(defaultChain("development").length).toBeGreaterThan(0)
  })

  it("formata SessionKey determinística por modelo e geração", () => {
    expect(formatSessionKey({
      agentId: "programador-senior",
      taskId: "701",
      phase: "development",
      model: "alibaba/qwen3.7-max",
      modelIndex: 0,
      generation: 2,
    })).toBe("agent:programador-senior:task:701:m0:g2:qwen3.7-max")
  })
})
