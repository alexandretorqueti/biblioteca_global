import { describe, expect, it } from "vitest"
import { getTableConfig } from "drizzle-orm/mysql-core"
import { promptsAgentes } from "../schema"
import { PROMPTS_AGENTES_SEED } from "../seed-prompts"
import { AGENT_PROMPT_CATALOG } from "../src/prompts/prompt-catalog"
import { OUTPUT_CONTRACT_CATALOG, outputContractDefault } from "../src/prompts/output-contract-catalog"
import { BUNDLED_PROMPT_DEFAULTS } from "../src/prompts/prompt-defaults.generated"
import { markersIn, validatePromptTemplate } from "../src/prompts/PromptTemplateEngine"

describe("prompts_agentes", () => {
  it("possui tipo, situação e conteúdo persistidos", () => {
    const columns = getTableConfig(promptsAgentes).columns
    for (const name of ["tipo_agente", "situacao", "conteudo"]) {
      const column = columns.find((candidate) => candidate.name === name)
      expect(column).toBeDefined()
      expect((column as unknown as { notNull: boolean }).notNull).toBe(true)
    }
  })

  it("contém um registro de seed para cada situação mapeada", () => {
    expect(PROMPTS_AGENTES_SEED).toHaveLength(AGENT_PROMPT_CATALOG.length)
    expect(PROMPTS_AGENTES_SEED.map((entry) => entry.chave)).toEqual(
      AGENT_PROMPT_CATALOG.map((entry) => entry.key),
    )
  })

  it("mantém os registros identificáveis e com marcadores", () => {
    for (const entry of PROMPTS_AGENTES_SEED) {
      expect(entry.tipoAgente).toBeTruthy()
      expect(entry.situacao).toBeTruthy()
      expect(entry.conteudo).toBeTruthy()
      expect(entry.origem).toMatch(/#[A-Za-z]/)
      if (entry.chave !== "biblioteca-global.helpdesk_atendimento") {
        expect(entry.marcadores.length).toBeGreaterThan(0)
      }
    }
  })
})

describe("geracao.plano_macro_projeto (Geração Macro F1, §5 da PROPOSTA-GERACAO-MACRO-TAREFAS)", () => {
  const entry = AGENT_PROMPT_CATALOG.find((item) => item.key === "geracao.plano_macro_projeto")

  it("existe no catálogo com agente, situação e contrato estáveis", () => {
    expect(entry).toBeDefined()
    expect(entry!.agentType).toBe("analista")
    expect(entry!.situation).toBe("geracao_plano_macro_projeto")
    expect(entry!.contractKey).toBe("geracao.plano_ou_perguntas")
    expect(entry!.source).toMatch(/#[A-Za-z]/)
  })

  it("declara todos os placeholders do §5 como marcadores", () => {
    const esperados = [
      "**NOME**",
      "**SLUG**",
      "**ESPECIFICACAO**",
      "**DESCRICAO**",
      "**CATALOGO_CRUD**",
      "**DOCS**",
      "**CHAT**",
      "**FEEDBACK**",
    ]
    for (const marker of esperados) {
      expect(entry!.markers).toContain(marker)
      expect(entry!.prompt).toContain(marker)
    }
    // Nenhum marcador não declarado no template.
    expect(markersIn(entry!.prompt).sort()).toEqual([...esperados, "**CONTRATOSAIDA**"].sort())
  })

  it("template é fiel ao §5: entradas, método 1–8, granularidade e contrato injetado", () => {
    const prompt = entry!.prompt
    expect(prompt).toContain("PLANO DE TAREFAS MACRO")
    expect(prompt).toContain("== ENTRADAS ==")
    expect(prompt).toContain("== MÉTODO OBRIGATÓRIO ==")
    for (const metodo of [
      "REQ-F-### (funcionais)",
      "REQ-NF-### (não-funcionais)",
      "REQ-D-### (dados/entidades)",
      "REQ-I-### (integrações)",
      "\"crud\" (cobre nativamente) | \"custom\" (exige tela/fluxo personalizado) | \"lacuna\"",
      "CAPACIDADE DE SISTEMA",
      "\"biblioteca-global\"",
      "\"agente-projeto\"",
      "especificacaoCrud",
      "MANUAL_CONFIG_PROJETOS",
      "matriz de cobertura",
      "lacunasBiblioteca[]",
      "devolva perguntas (máx. 8",
    ]) {
      expect(prompt).toContain(metodo)
    }
    expect(prompt).toContain("8 a 15 tarefas macro")
    expect(prompt.trimEnd().endsWith("**CONTRATOSAIDA**")).toBe(true)
    const validacao = validatePromptTemplate(prompt, [...entry!.markers, "**CONTRATOSAIDA**"], ["**CONTRATOSAIDA**"])
    expect(validacao).toEqual({ ok: true, unknown: [], missing: [], used: expect.arrayContaining(["**CONTRATOSAIDA**"]) })
  })

  it("entra no seed derivado do catálogo (chave estável, carga idempotente)", () => {
    const seeded = PROMPTS_AGENTES_SEED.find((item) => item.chave === "geracao.plano_macro_projeto")
    expect(seeded).toBeDefined()
    expect(seeded!.tipoAgente).toBe("analista")
    expect(seeded!.situacao).toBe("geracao_plano_macro_projeto")
    expect(seeded!.marcadores).toEqual([...entry!.markers])
  })

  it("snapshot versionado contém a nova chave com texto do catálogo e instruções do contrato", () => {
    const bundled = BUNDLED_PROMPT_DEFAULTS["geracao.plano_macro_projeto"]
    expect(bundled).toBeDefined()
    expect(bundled.text).toBe(entry!.prompt)
    expect(bundled.contractKey).toBe("geracao.plano_ou_perguntas")
    expect(bundled.contractInstructions).toBe(outputContractDefault("geracao.plano_ou_perguntas")!.instructions)
  })
})

describe("contrato geracao.plano_ou_perguntas", () => {
  const contract = outputContractDefault("geracao.plano_ou_perguntas")

  it("existe no catálogo de contratos com as duas formas do §5", () => {
    expect(contract).toBeDefined()
    expect(OUTPUT_CONTRACT_CATALOG.filter((item) => item.key === "geracao.plano_ou_perguntas")).toHaveLength(1)
    const oneOf = (contract!.schema as { oneOf: Record<string, unknown>[] }).oneOf
    expect(oneOf).toHaveLength(2)
    const kinds = oneOf.map((form) => (form as { properties: { kind: { const: string } } }).properties.kind.const)
    expect(kinds.sort()).toEqual(["perguntas", "plano"])
  })

  it("forma plano exige os campos do §5", () => {
    const oneOf = (contract!.schema as { oneOf: { required: string[]; properties: Record<string, unknown> }[] }).oneOf
    const plano = oneOf.find((form) => form.required.includes("classificacaoSistema"))!
    for (const field of [
      "kind",
      "classificacaoSistema",
      "requerAgenteDedicado",
      "requisitos",
      "especificacaoCrud",
      "tarefas",
      "matrizCobertura",
      "lacunas",
      "lacunasBiblioteca",
      "riscos",
      "foraDeFase",
    ]) {
      expect(plano.required).toContain(field)
      expect(plano.properties[field]).toBeDefined()
    }
    const tarefas = plano.properties.tarefas as { items: { required: string[]; properties: Record<string, unknown> } }
    for (const field of ["seq", "titulo", "objetivo", "escopo", "aceite", "requisitos", "executor", "depende_de", "auto_start", "risco"]) {
      expect(tarefas.items.required).toContain(field)
      expect(tarefas.items.properties[field]).toBeDefined()
    }
    const executor = tarefas.items.properties.executor as { enum: string[] }
    expect(executor.enum).toEqual(["biblioteca-global", "agente-projeto"])
  })

  it("forma perguntas limita a no máximo 8 perguntas", () => {
    const oneOf = (contract!.schema as { oneOf: { required: string[]; properties: Record<string, { maxItems?: number; minItems?: number }> }[] }).oneOf
    const perguntas = oneOf.find((form) => form.required.includes("perguntas"))!
    expect(perguntas.properties.perguntas.maxItems).toBe(8)
    expect(perguntas.properties.perguntas.minItems).toBe(1)
    expect(perguntas.required).toEqual(["kind", "resumo", "perguntas"])
  })

  it("exemplo satisfaz a forma plano", () => {
    const example = contract!.example as Record<string, unknown>
    expect(example.kind).toBe("plano")
    const oneOf = (contract!.schema as { oneOf: { required: string[] }[] }).oneOf
    const plano = oneOf.find((form) => form.required.includes("classificacaoSistema"))!
    for (const field of plano.required) {
      expect(example).toHaveProperty(field)
    }
  })
})
