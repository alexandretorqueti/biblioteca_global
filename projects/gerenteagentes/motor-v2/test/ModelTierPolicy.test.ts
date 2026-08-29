import { describe, expect, it } from "vitest"
import { defaultChain, formatSessionKey, isModelUnavailableError } from "../src/policies/ModelTierPolicy.js"

describe("ModelTierPolicy", () => {
  it("mantém cadeias distintas para análise e desenvolvimento", () => {
    expect(defaultChain("analysis").length).toBeGreaterThan(0)
    expect(defaultChain("development").length).toBeGreaterThan(0)
  })

  it("formata a SessionKey do desenvolvimento no padrão operacional", () => {
    expect(formatSessionKey({
      agentId: "programador-senior",
      taskId: "701",
      phase: "development",
      model: "alibaba/qwen3.7-max",
      modelIndex: 0,
      generation: 2,
    })).toBe("dev-qwen3.7-max-701")
  })

  it("formata a SessionKey da análise no padrão operacional", () => {
    expect(formatSessionKey({
      agentId: "programador-senior",
      taskId: "701",
      phase: "analysis",
      model: "alibaba/qwen3.8-max",
      modelIndex: 0,
      generation: 0,
    })).toBe("analysis-qwen3.8-max-701")
  })

  it("reconhece indisponibilidade de modelo sem confundir erro operacional genérico", () => {
    const unavailable = Object.assign(new Error("Model not found"), { status: 404, code: "MODEL_NOT_FOUND" })
    expect(isModelUnavailableError(unavailable)).toBe(true)
    expect(isModelUnavailableError(new Error("ECONNREFUSED"))).toBe(false)
  })
})
