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

  it("mantém a sessão de desenvolvimento estável no rework e isolada por subtarefa", () => {
    const common = {
      agentId: "programador-senior",
      taskId: "701",
      phase: "development" as const,
      model: "openai/gpt-5.6-terra",
      modelIndex: 0,
    }
    const firstAttempt = formatSessionKey({ ...common, subtaskId: "810", generation: 0 })
    const rework = formatSessionKey({ ...common, subtaskId: "810", generation: 2 })
    const anotherSubtask = formatSessionKey({ ...common, subtaskId: "811", generation: 0 })

    expect(rework).toBe(firstAttempt)
    expect(anotherSubtask).not.toBe(firstAttempt)
  })

  it("reconhece indisponibilidade de modelo sem confundir erro operacional genérico", () => {
    const unavailable = Object.assign(new Error("Model not found"), { status: 404, code: "MODEL_NOT_FOUND" })
    expect(isModelUnavailableError(unavailable)).toBe(true)
    expect(isModelUnavailableError(new Error("ECONNREFUSED"))).toBe(false)
  })

  it("reconhece modelo recusado pelo runtime como indisponível para a cadeia", () => {
    expect(isModelUnavailableError(new Error("model not allowed: provider/indisponivel"))).toBe(true)
  })
})
