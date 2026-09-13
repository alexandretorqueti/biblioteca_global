import { describe, expect, it } from "vitest"
import { diagnosticText, MAX_DIAGNOSTIC_TEXT_LENGTH } from "../src/shared/diagnosticText.js"

describe("diagnosticText", () => {
  it("preserva evidência longa até o limite diagnóstico", () => {
    expect(diagnosticText("x".repeat(1_000))).toHaveLength(1_000)
  })

  it("usa fallback e aplica o limite alto", () => {
    expect(diagnosticText(null, "fallback")).toBe("fallback")
    expect(diagnosticText("x".repeat(MAX_DIAGNOSTIC_TEXT_LENGTH + 1))).toHaveLength(MAX_DIAGNOSTIC_TEXT_LENGTH)
  })
})
