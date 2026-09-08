import { describe, expect, it } from "vitest"
import {
  persistPlanProposal,
  approvePlanProposal,
  rejectPlanProposal,
  fetchApprovedPlanProposal,
  fetchPendingPlanProposal,
  fetchPlanProposalHistory,
} from "../src/planning/PlanProposalStore.js"
import type { PlanCoverage, PlannedSubtask } from "../src/planning/PlanPersistence.js"

/**
 * Banco em memória mínimo para testar o PlanProposalStore.
 * Simula as operações SQL usadas pelo store.
 */
function createMockDb() {
  const proposals: Array<Record<string, unknown>> = []
  const tasks: Array<{ id: number; external_id: string }> = [{ id: 100, external_id: "task-test-1" }]
  let proposalIdSeq = 0

  return {
    async query(sql: string, params: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, " ").trim()

      // resolveTaskDatabaseId
      if (normalized.includes("FROM tarefas WHERE external_id")) {
        const externalId = String(params[0])
        const task = tasks.find((t) => t.external_id === externalId || String(t.id) === externalId)
        return { rows: task ? [{ id: task.id }] : [] }
      }

      // MAX(version)
      if (normalized.includes("COALESCE(MAX(version)")) {
        const taskId = Number(params[0])
        const versions = proposals.filter((p) => Number(p.tarefa_id) === taskId).map((p) => Number(p.version))
        const max = versions.length > 0 ? Math.max(...versions) : 0
        return { rows: [{ max_version: max }] }
      }

      // INSERT
      if (normalized.startsWith("INSERT INTO motor_plan_proposals")) {
        proposalIdSeq++
        const [taskId, version, subtasksJson, coverageJson] = params
        proposals.push({
          id: proposalIdSeq,
          tarefa_id: taskId,
          version,
          status: "proposed",
          subtasks_json: subtasksJson,
          coverage_json: coverageJson,
          proposed_at: new Date().toISOString(),
          decided_at: null,
          decided_by: null,
          decision_reason: null,
        })
        return { rows: [] }
      }

      // SELECT by id (after insert)
      if (normalized.includes("FROM motor_plan_proposals WHERE tarefa_id") && normalized.includes("AND version")) {
        const taskId = Number(params[0])
        const version = Number(params[1])
        const found = proposals.filter((p) => Number(p.tarefa_id) === taskId && Number(p.version) === version)
        return { rows: found }
      }

      // SELECT proposed (latest)
      if (normalized.includes("FROM motor_plan_proposals WHERE tarefa_id") && normalized.includes("status = 'proposed'")) {
        const taskId = Number(params[0])
        const found = proposals
          .filter((p) => Number(p.tarefa_id) === taskId && p.status === "proposed")
          .sort((a, b) => Number(b.version) - Number(a.version))
        return { rows: found.length > 0 ? [found[0]] : [] }
      }

      // SELECT approved (latest)
      if (normalized.includes("FROM motor_plan_proposals WHERE tarefa_id") && normalized.includes("status = 'approved'")) {
        const taskId = Number(params[0])
        const found = proposals
          .filter((p) => Number(p.tarefa_id) === taskId && p.status === "approved")
          .sort((a, b) => Number(b.version) - Number(a.version))
        return { rows: found.length > 0 ? [found[0]] : [] }
      }

      // SELECT all (history)
      if (normalized.includes("FROM motor_plan_proposals WHERE tarefa_id") && normalized.includes("ORDER BY version ASC")) {
        const taskId = Number(params[0])
        const found = proposals
          .filter((p) => Number(p.tarefa_id) === taskId)
          .sort((a, b) => Number(a.version) - Number(b.version))
        return { rows: found }
      }

      // UPDATE status
      if (normalized.startsWith("UPDATE motor_plan_proposals SET status")) {
        // SQL: UPDATE ... SET status = 'approved', decided_at = NOW(), decided_by = ?, decision_reason = ? WHERE id = ?
        // Params: [decidedBy, reason, id]
        const decidedBy = params[0]
        const reason = params[1]
        const id = params[2]
        // Extrai o status do SQL (hardcoded como 'approved' ou 'rejected')
        const statusMatch = normalized.match(/status = '(\w+)'/)
        const status = statusMatch ? statusMatch[1] : "approved"
        const proposal = proposals.find((p) => Number(p.id) === Number(id))
        if (proposal) {
          proposal.status = status
          proposal.decided_by = decidedBy
          proposal.decision_reason = reason
          proposal.decided_at = new Date().toISOString()
        }
        return { rows: [] }
      }

      return { rows: [] }
    },
  }
}

const sampleSubtasks: PlannedSubtask[] = [
  {
    seq: 1,
    titulo: "Implementar validação",
    scope: "Criar função de validação com critérios claros e testes unitários",
    acceptanceCriteria: ["Função valida entrada", "Testes cobrem casos limite"],
    deliverables: ["src/validator.ts", "tests/validator.test.ts"],
    requirementsCovered: ["REQ-1"],
    dependsOn: [],
  },
]

const sampleCoverage: PlanCoverage = {
  requirements: [{ id: "REQ-1", description: "Validação de entrada" }],
  coverage: [{ requirement: "REQ-1", coveredBy: [1] }],
}

describe("PlanProposalStore", () => {
  it("persiste uma proposta de plano com versão 1", async () => {
    const db = createMockDb()
    const proposal = await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    expect(proposal.version).toBe(1)
    expect(proposal.status).toBe("proposed")
    expect(proposal.subtasks).toHaveLength(1)
    expect(proposal.subtasks[0]!.titulo).toBe("Implementar validação")
  })

  it("incrementa versão a cada nova proposta", async () => {
    const db = createMockDb()
    const v1 = await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    const v2 = await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
  })

  it("aprova a proposta pendente mais recente", async () => {
    const db = createMockDb()
    await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    const approved = await approvePlanProposal(db as any, "task-test-1", "alexandre")
    expect(approved).not.toBeNull()
    expect(approved!.status).toBe("approved")
    expect(approved!.decidedBy).toBe("alexandre")
  })

  it("retorna null ao aprovar quando não há proposta pendente", async () => {
    const db = createMockDb()
    const result = await approvePlanProposal(db as any, "task-test-1")
    expect(result).toBeNull()
  })

  it("rejeita a proposta pendente com motivo", async () => {
    const db = createMockDb()
    await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    const rejected = await rejectPlanProposal(db as any, "task-test-1", "alexandre", "Escopo insuficiente")
    expect(rejected).not.toBeNull()
    expect(rejected!.status).toBe("rejected")
    expect(rejected!.decisionReason).toBe("Escopo insuficiente")
  })

  it("busca a proposta aprovada mais recente", async () => {
    const db = createMockDb()
    await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    await approvePlanProposal(db as any, "task-test-1")
    const found = await fetchApprovedPlanProposal(db as any, "task-test-1")
    expect(found).not.toBeNull()
    expect(found!.status).toBe("approved")
  })

  it("busca a proposta pendente", async () => {
    const db = createMockDb()
    await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    const found = await fetchPendingPlanProposal(db as any, "task-test-1")
    expect(found).not.toBeNull()
    expect(found!.status).toBe("proposed")
  })

  it("não retorna proposta pendente após aprovação", async () => {
    const db = createMockDb()
    await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    await approvePlanProposal(db as any, "task-test-1")
    const pending = await fetchPendingPlanProposal(db as any, "task-test-1")
    expect(pending).toBeNull()
  })

  it("retorna histórico completo das propostas", async () => {
    const db = createMockDb()
    await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    await persistPlanProposal(db as any, "task-test-1", sampleSubtasks, sampleCoverage)
    const history = await fetchPlanProposalHistory(db as any, "task-test-1")
    expect(history).toHaveLength(2)
    expect(history[0]!.version).toBe(1)
    expect(history[1]!.version).toBe(2)
  })
})
