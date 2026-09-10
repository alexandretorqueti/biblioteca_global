import { describe, expect, it } from "vitest"
import { AGENT_PROMPT_CATALOG } from "../src/prompts/prompt-catalog.js"
import { BUNDLED_PROMPT_DEFAULTS } from "../src/prompts/prompt-defaults.generated.js"
import { OUTPUT_CONTRACT_CATALOG } from "../src/prompts/output-contract-catalog.js"

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
      "analista.revisao_premissa_incorreta",
      "auditor.auditoria_premissa_incorreta",
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

  it("mantém o texto administrável sem duplicar a proteção sistêmica de workspace", () => {
    const prompts = AGENT_PROMPT_CATALOG.filter((entry) => entry.agentType === "dev").map((entry) => entry.prompt).join("\n")
    expect(prompts).toContain("Workspace: **WORKSPACE**")
    expect(prompts).toContain("**CONTRATOSAIDA**")
    expect(prompts).not.toContain("git rev-parse --show-toplevel")
  })
})

describe("prompts do analista orientam diálogo natural", () => {
  const primeiraRodada = AGENT_PROMPT_CATALOG.find((e) => e.key === "analista.primeira_rodada_tarefa")!
  const retomada = AGENT_PROMPT_CATALOG.find((e) => e.key === "analista.retomada_apos_clarificacao")!

  it("o prompt da primeira rodada orienta conversa natural em vez de formulário", () => {
    expect(primeiraRodada.prompt).toContain("converse com o dono para esclarecer")
    expect(primeiraRodada.prompt).not.toContain("peça esclarecimentos")
  })

  it("o prompt de retomada orienta continuação da conversa em linguagem natural", () => {
    expect(retomada.prompt).toContain("Continue a conversa")
    expect(retomada.prompt).toContain("linguagem natural")
    expect(retomada.prompt).toContain("continue conversando")
  })

  it("os bundled defaults reforçam a conversa natural e a proibição de execução sem aprovação", () => {
    const primeira = BUNDLED_PROMPT_DEFAULTS["analista.primeira_rodada_tarefa"]
    const ret = BUNDLED_PROMPT_DEFAULTS["analista.retomada_apos_clarificacao"]
    expect(primeira?.contractInstructions).toContain("CONVERSA NATURAL")
    expect(primeira?.contractInstructions).toContain("PROIBIDO criar subtarefas")
    expect(primeira?.contractInstructions).toContain("aprovação explícita")
    expect(ret?.contractInstructions).toContain("CONVERSA NATURAL")
    expect(ret?.contractInstructions).toContain("PROIBIDO criar subtarefas")
  })
})

describe("contrato de saída do analista preserva validação estruturada", () => {
  const contract = OUTPUT_CONTRACT_CATALOG.find((c) => c.key === "analista.plano_ou_perguntas")!

  it("as instruções do contrato orientam conversa natural com JSON técnico interno", () => {
    expect(contract.instructions).toContain("CONVERSA NATURAL")
    expect(contract.instructions).toContain("texto livre")
    expect(contract.instructions).toContain("PROIBIDO criar subtarefas")
    expect(contract.instructions).toContain("aprovação explícita")
    expect(contract.instructions).toContain("JSON técnico")
  })

  it("o schema do contrato mantém a estrutura técnica do plano (subtarefas, requirements, coverage)", () => {
    const schema = contract.schema as { oneOf: Array<{ properties: Record<string, unknown> }> }
    const planSchema = schema.oneOf.find((s) => s.properties?.subtarefas)
    expect(planSchema).toBeDefined()
    expect(planSchema?.properties).toHaveProperty("subtarefas")
    expect(planSchema?.properties).toHaveProperty("requirements")
    expect(planSchema?.properties).toHaveProperty("coverage")
  })
})
