import { describe, expect, it } from "vitest"
import { TaskWorker, analystCorrectiveFeedback, truncateDescriptionForAnalyst } from "../src/workers/TaskWorker.js"

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
  it("truncado pede JSON mais curto", () => {
    const feedback = analystCorrectiveFeedback("truncated")
    expect(feedback).toContain("cortada no meio do JSON")
    expect(feedback).toContain("reduzindo redundancias")
    expect(feedback).toContain("APENAS com o JSON")
  })

  it("invalido pede JSON válido no formato esperado", () => {
    const feedback = analystCorrectiveFeedback("invalid")
    expect(feedback).toContain("nao continha JSON valido")
    expect(feedback).toContain("APENAS com o JSON")
  })
})
