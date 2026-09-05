import { describe, expect, it } from "vitest"
import { AGENT_PROMPT_CATALOG } from "../src/prompts/prompt-catalog.js"

describe("catálogo de prompts dos agentes", () => {
  it("mantém um registro para cada situação de composição mapeada", () => {
    expect(AGENT_PROMPT_CATALOG.map((entry) => entry.key)).toEqual([
      "biblioteca-global.setup_projeto",
      "analista.primeira_rodada_tarefa",
      "analista.retomada_apos_clarificacao",
      "analista.retry_resposta_invalida",
      "dev.primeira_rodada_tarefa",
      "dev.retorno_por_falha_de_gate",
      "monitor.classificacao_falha_de_gate",
      "monitor.correcao_motor",
    ])
  })

  it("identifica agente, situação, origem e marcadores sem validar o prompt", () => {
    for (const entry of AGENT_PROMPT_CATALOG) {
      expect(entry.agentType).toBeTruthy()
      expect(entry.situation).toBeTruthy()
      expect(entry.source).toMatch(/#[A-Za-z]/)
      expect(entry.markers.length).toBeGreaterThan(0)
      expect(typeof entry.prompt).toBe("string")
    }
  })
})

