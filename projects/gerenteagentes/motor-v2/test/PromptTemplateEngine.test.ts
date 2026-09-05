import { describe, expect, it } from "vitest"
import { ManagedPromptResolver, markersIn, renderPromptTemplate, validatePromptTemplate } from "../src/prompts/PromptTemplateEngine.js"

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

  it("injeta o contrato embarcado no fallback mesmo se o texto legado não tiver a máscara", async () => {
    const db = { query: async (sql: string) => sql.startsWith("SELECT") ? [[], []] : [[], []] }
    const output = await new ManagedPromptResolver(db).resolve({
      key: "analista.primeira_rodada_tarefa",
      values: {},
      fallback: "Planeje a tarefa.",
    })
    expect(output).toContain("CONTRATO DE SAÍDA OBRIGATÓRIO")
    expect(output).toContain('"subtarefas"')
    expect(output).toContain('"kind":"perguntas"')
  })
})
