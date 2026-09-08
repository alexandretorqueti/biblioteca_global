import { describe, expect, it } from "vitest"
import { TaskWorker, analystCorrectiveFeedback, analystPlanRejectionFeedback, formatAnalystOutputContract, splitAnalystDescription, truncateDescriptionForAnalyst } from "../src/workers/TaskWorker.js"

type PromptBuilder = {
  buildAnalystPrompt: (task: { title: string; description?: string }, clarificationHistory?: string) => string
}

function buildPrompt(task: { title: string; description?: string }): string {
  const worker = new TaskWorker() as unknown as PromptBuilder
  return worker.buildAnalystPrompt(task)
}

describe("truncateDescriptionForAnalyst", () => {
  it("mantém descrição curta intacta", () => {
    expect(truncateDescriptionForAnalyst("descricao curta")).toBe("descricao curta")
  })

  it("ausente vira N/A", () => {
    expect(truncateDescriptionForAnalyst(undefined)).toBe("N/A")
  })

  it("preserva descrição gigante integralmente", () => {
    const huge = "x".repeat(7300)
    const result = truncateDescriptionForAnalyst(huge)
    expect(result).toBe(huge)
  })
})

describe("buildAnalystPrompt (limites anti-truncamento)", () => {
  it("exige cobertura integral sem minimizar subtarefas", () => {
    const prompt = buildPrompt({ title: "Tarefa exemplo", description: "descricao" })
    expect(prompt).toContain("cobrir integralmente o escopo")
    expect(prompt).toContain("sem passar de 10")
    expect(prompt).not.toContain("2 a 4 no maximo")
    expect(prompt).not.toContain("Crie no maximo 4 subtarefas")
  })

  it("limites de tamanho por campo", () => {
    const prompt = buildPrompt({ title: "Tarefa exemplo", description: "descricao" })
    expect(prompt).toContain("titulo: curto, ate ~80 caracteres")
    expect(prompt).toContain("scope: responsabilidade principal detalhada")
    expect(prompt).toContain("acceptance_criteria: 2 a 8 itens objetivos")
    expect(prompt).toContain("requirements/coverage")
  })

  it("instrui a não omitir requisitos da descrição da tarefa", () => {
    const prompt = buildPrompt({ title: "Tarefa exemplo", description: "descricao" })
    expect(prompt).toContain("nao esconda requisitos")
  })

  it("descrição gigante chega integral ao analista", () => {
    const prompt = buildPrompt({ title: "Tarefa exemplo", description: "y".repeat(9000) })
    expect(prompt).toContain("y".repeat(9000))
  })

  it("mantém as duas formas de resposta (plano e perguntas)", () => {
    const prompt = buildPrompt({ title: "Tarefa exemplo", description: "descricao" })
    expect(prompt).toContain('"subtarefas": [')
    expect(prompt).toContain('"kind": "perguntas"')
  })
})

describe("analystCorrectiveFeedback", () => {
  const contract = formatAnalystOutputContract({
    instructions: "Use subtarefas.",
    schema: { required: ["subtarefas"] },
    example: { subtarefas: [] },
  })

  it("truncado pede JSON mais curto", () => {
    const feedback = analystCorrectiveFeedback("truncated", "fim inesperado", contract)
    expect(feedback).toContain("cortada no meio do JSON")
    expect(feedback).toContain("reduzindo redundancias")
    expect(feedback).toContain("fim inesperado")
    expect(feedback).toContain('"subtarefas"')
    expect(feedback).toContain("APENAS com o JSON")
  })

  it("invalido pede JSON válido no formato esperado", () => {
    const feedback = analystCorrectiveFeedback("invalid", "campo subtarefas ausente", contract)
    expect(feedback).toContain("nao foi reconhecida")
    expect(feedback).toContain("campo subtarefas ausente")
    expect(feedback).toContain("JSON Schema")
    expect(feedback).toContain("Exemplo completo valido")
    expect(feedback).toContain("APENAS com o JSON")
  })
})

describe("contexto completo do analista", () => {
  it("divide a descrição sem perda e preserva início e fim", () => {
    const description = "A".repeat(6000) + "B".repeat(6000) + "FIM"
    const chunks = splitAnalystDescription(description)
    expect(chunks).toHaveLength(3)
    expect(chunks.join("")).toBe(description)
    expect(chunks.at(-1)).toBe("FIM")
  })

  it("formata instruções, schema e exemplo completos", () => {
    const contract = formatAnalystOutputContract({ instructions: "Instrução", schema: { type: "object" }, example: { subtarefas: [] } })
    expect(contract).toContain("CONTRATO DE SAIDA OBRIGATORIO")
    expect(contract).toContain("JSON Schema completo")
    expect(contract).toContain("Exemplo completo valido")
    // Mesmo se a tabela estiver com schema/exemplo degradados, o agente recebe
    // o protocolo estrutural completo que o parser do Motor exige.
    expect(contract).toContain('"requirements_covered"')
    expect(contract).toContain('"depends_on"')
    expect(contract).toContain('"requirement"')
    expect(contract).toContain('"covered_by"')
    expect(contract).toContain('"REQ-1"')
    expect(contract).not.toContain('"subtarefas": []')
  })

  it("reenvia o contrato completo quando a qualidade semântica rejeita o plano", () => {
    const contract = formatAnalystOutputContract({ instructions: "Instrução", schema: null, example: null })
    const feedback = analystPlanRejectionFeedback("Requisito REQ-01 não possui cobertura.", contract)
    expect(feedback).toContain("Requisito REQ-01 não possui cobertura.")
    expect(feedback).toContain("JSON Schema completo")
    expect(feedback).toContain("Exemplo completo valido")
    expect(feedback).toContain('"requirement"')
    expect(feedback).toContain('"covered_by"')
    expect(feedback).toContain('"requirements_covered"')
  })
})
