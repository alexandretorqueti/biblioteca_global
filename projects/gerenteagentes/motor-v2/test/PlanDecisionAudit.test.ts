import { describe, expect, it } from "vitest"
import {
  persistPlanDecision,
  fetchPlanDecisions,
  persistTaskPlanProposal,
  persistTaskClarificationAnswer,
  formatPlanProposalMessage,
  type PlanDecision,
} from "../src/planning/ClarificationStore.js"

/**
 * Banco em memória para testar as funções de auditoria de decisões.
 */
function createMockDb() {
  const chats: Array<Record<string, unknown>> = []
  const tasks: Array<{ id: number; external_id: string }> = [{ id: 100, external_id: "task-decision-1" }]
  let chatIdSeq = 0

  return {
    async query(sql: string, params: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim()

      // resolveTaskDatabaseId
      if (normalized.includes("FROM tarefas WHERE external_id")) {
        const externalId = String(params[0])
        const task = tasks.find((t) => t.external_id === externalId || String(t.id) === externalId)
        return { rows: task ? [{ id: task.id }] : [] }
      }

      // INSERT into tarefa_chats
      if (normalized.startsWith("INSERT INTO tarefa_chats")) {
        chatIdSeq++
        const [taskId, role, author, texto] = params
        chats.push({
          id: chatIdSeq,
          tarefa_id: taskId,
          role,
          author: author ?? null,
          texto,
          created_at: new Date().toISOString(),
        })
        return { rows: [] }
      }

      // SELECT decisions from tarefa_chats
      if (normalized.includes("FROM tarefa_chats") && normalized.includes("texto LIKE")) {
        const taskId = Number(params[0])
        const found = chats.filter((c) => {
          if (Number(c.tarefa_id) !== taskId) return false
          const text = String(c.texto ?? "")
          return text.startsWith("✅") || text.startsWith("✏️") || text.startsWith("💬")
        })
        return { rows: found }
      }

      // SELECT all chats (for history)
      if (normalized.includes("FROM tarefa_chats") && normalized.includes("role IN")) {
        const taskId = Number(params[0])
        const found = chats.filter((c) => Number(c.tarefa_id) === taskId)
        return { rows: found }
      }

      return { rows: [] }
    },
  }
}

describe("Plan Decision Audit", () => {
  it("persiste decisão de aprovação no chat", async () => {
    const db = createMockDb()
    await persistPlanDecision(db as any, "task-decision-1", "approve", "alexandre", null)
    const decisions = await fetchPlanDecisions(db as any, "task-decision-1")
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toBe("approve")
    expect(decisions[0]!.actor).toBe("alexandre")
    expect(decisions[0]!.reason).toBeNull()
  })

  it("persiste decisão de ajustes com motivo", async () => {
    const db = createMockDb()
    await persistPlanDecision(db as any, "task-decision-1", "request_adjustments", "alexandre", "Escopo insuficiente")
    const decisions = await fetchPlanDecisions(db as any, "task-decision-1")
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toBe("request_adjustments")
    expect(decisions[0]!.actor).toBe("alexandre")
    expect(decisions[0]!.reason).toBe("Escopo insuficiente")
  })

  it("persiste decisão de continuar conversando", async () => {
    const db = createMockDb()
    await persistPlanDecision(db as any, "task-decision-1", "continue_conversation", "alexandre", "Quero entender melhor o escopo")
    const decisions = await fetchPlanDecisions(db as any, "task-decision-1")
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toBe("continue_conversation")
    expect(decisions[0]!.actor).toBe("alexandre")
    expect(decisions[0]!.reason).toBe("Quero entender melhor o escopo")
  })

  it("mantém histórico de múltiplas decisões em ordem", async () => {
    const db = createMockDb()
    await persistPlanDecision(db as any, "task-decision-1", "continue_conversation", "alexandre", "Primeira pergunta")
    await persistPlanDecision(db as any, "task-decision-1", "continue_conversation", "alexandre", "Segunda pergunta")
    await persistPlanDecision(db as any, "task-decision-1", "approve", "alexandre", null)
    const decisions = await fetchPlanDecisions(db as any, "task-decision-1")
    expect(decisions).toHaveLength(3)
    expect(decisions[0]!.decision).toBe("continue_conversation")
    expect(decisions[1]!.decision).toBe("continue_conversation")
    expect(decisions[2]!.decision).toBe("approve")
  })

  it("retorna vazio quando não há decisões registradas", async () => {
    const db = createMockDb()
    const decisions = await fetchPlanDecisions(db as any, "task-decision-1")
    expect(decisions).toHaveLength(0)
  })
})

describe("formatPlanProposalMessage", () => {
  it("formata a proposta com ações disponíveis", () => {
    const message = formatPlanProposalMessage({
      version: 1,
      subtasks: [
        {
          seq: 1,
          titulo: "Implementar validação",
          scope: "Criar função de validação",
          acceptanceCriteria: ["Valida entrada"],
          deliverables: ["src/validator.ts"],
          requirementsCovered: ["REQ-1"],
          dependsOn: [],
        },
      ],
    })
    expect(message).toContain("Proposta de Plano")
    expect(message).toContain("versão 1")
    expect(message).toContain("Implementar validação")
    expect(message).toContain("Aprovar e iniciar")
    expect(message).toContain("Solicitar ajustes")
    expect(message).toContain("Continuar conversando")
  })

  it("lista dependências quando presentes", () => {
    const message = formatPlanProposalMessage({
      version: 2,
      subtasks: [
        {
          seq: 1,
          titulo: "Schema",
          scope: "Criar schema",
          acceptanceCriteria: [],
          deliverables: [],
          requirementsCovered: [],
          dependsOn: [],
        },
        {
          seq: 2,
          titulo: "API",
          scope: "Criar endpoints",
          acceptanceCriteria: [],
          deliverables: [],
          requirementsCovered: [],
          dependsOn: [1],
        },
      ],
    })
    expect(message).toContain("Depende de: seq 1")
  })
})
