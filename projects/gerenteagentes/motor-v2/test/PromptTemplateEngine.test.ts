import { describe, expect, it } from "vitest"
import { markersIn, renderPromptTemplate, validatePromptTemplate } from "../src/prompts/PromptTemplateEngine.js"

describe("PromptTemplateEngine", () => {
  it("descobre, valida e renderiza máscaras canônicas", () => {
    const text = "Tarefa: **TEXTOTAREFA**\nErro: **ERROREPORTADOPELOAGENTEDEV**"
    expect(markersIn(text)).toEqual(["**TEXTOTAREFA**", "**ERROREPORTADOPELOAGENTEDEV**"])
    expect(validatePromptTemplate(text, markersIn(text), ["**TEXTOTAREFA**"]).ok).toBe(true)
    expect(renderPromptTemplate(text, {
      "**TEXTOTAREFA**": "Corrigir API",
      "**ERROREPORTADOPELOAGENTEDEV**": "schema divergente",
    })).toContain("Tarefa: Corrigir API")
  })

  it("reprova máscara desconhecida e obrigatória ausente", () => {
    const result = validatePromptTemplate("**DESCONHECIDA**", ["**TEXTOTAREFA**"], ["**TEXTOTAREFA**"])
    expect(result.ok).toBe(false)
    expect(result.unknown).toEqual(["**DESCONHECIDA**"])
    expect(result.missing).toEqual(["**TEXTOTAREFA**"])
  })
})
