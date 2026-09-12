import { describe, expect, it } from "vitest"
import {
  GlobalModelSelectionValidationError,
  parseGlobalModelSelection,
  type GlobalModelSelection,
} from "../../src/shared/global-model-selection"

const entry = (ordem: number) => ({ ordem, provider: "openai", model: "gpt-5", enabled: true })
const valid: GlobalModelSelection = {
  DEV: [entry(1)],
  ANALYST: [entry(1)],
  MONITOR: [entry(1)],
}

describe("contrato de configuração global de modelos", () => {
  it("aceita DEV, ANALYST e MONITOR com entradas válidas", () => {
    expect(parseGlobalModelSelection(valid)).toEqual(valid)
  })

  it("rejeita ausência de um tipo e fila vazia", () => {
    const payload = { DEV: [entry(1)], ANALYST: [entry(1)], MONITOR: [] }
    expect(() => parseGlobalModelSelection(payload)).toThrow(GlobalModelSelectionValidationError)
  })

  it("rejeita provider/model vazios e ordem inválida", () => {
    const payload = {
      ...valid,
      DEV: [{ ordem: 0, provider: " ", model: "", enabled: true }],
    }
    expect(() => parseGlobalModelSelection(payload)).toThrow(/ordem.*provider.*model/)
  })

  it("rejeita tipo desconhecido e campos extras", () => {
    expect(() => parseGlobalModelSelection({ ...valid, QA: [entry(1)] })).toThrow()
    expect(() => parseGlobalModelSelection({ ...valid, DEV: [{ ...entry(1), extra: true }] })).toThrow()
  })
})

