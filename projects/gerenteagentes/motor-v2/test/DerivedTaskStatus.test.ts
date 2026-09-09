import { describe, expect, it } from "vitest"
import { deriveTaskStatus, isTaskExecutionEligible } from "../src/policies/DerivedTaskStatus.js"

const facts = (overrides: Partial<Parameters<typeof deriveTaskStatus>[0]> = {}) => ({
  hasPendingClarification: false,
  hasActiveBlocker: false,
  analysisInProgress: false,
  hasPersistedPlan: false,
  subtaskStatuses: [],
  deploySucceeded: false,
  integrationConfirmed: false,
  ...overrides,
})

describe("deriveTaskStatus", () => {
  it("aplica a ordem de prioridade dos fatos", () => {
    expect(deriveTaskStatus(facts({
      hasPendingClarification: true,
      hasActiveBlocker: true,
      analysisInProgress: true,
      subtaskStatuses: ["running"],
      deploySucceeded: true,
      integrationConfirmed: true,
    }))).toBe("awaiting_clarification")
  })

  it("não permite ready enquanto existe execução ativa", () => {
    expect(deriveTaskStatus(facts({
      hasPersistedPlan: true,
      subtaskStatuses: ["verified", "running", "pending"],
    }))).toBe("running")
  })

  it("só conclui quando todas as subtarefas aprovadas foram integradas", () => {
    expect(deriveTaskStatus(facts({
      subtaskStatuses: ["verified", "superseded"],
      integrationConfirmed: false,
    }))).toBe("ready")
    expect(deriveTaskStatus(facts({
      subtaskStatuses: ["verified", "superseded"],
      integrationConfirmed: true,
    }))).toBe("completed")
  })

  it("retorna ready quando há pendência, inclusive dependência aguardando", () => {
    expect(deriveTaskStatus(facts({
      hasPersistedPlan: true,
      subtaskStatuses: ["verified", "pending"],
    }))).toBe("ready")
  })

  it("trata deploy confirmado como deployed", () => {
    expect(deriveTaskStatus(facts({
      subtaskStatuses: ["verified"],
      integrationConfirmed: true,
      deploySucceeded: true,
    }))).toBe("deployed")
  })

  it("preserva cancelamento e falha administrativos durante a migração", () => {
    expect(deriveTaskStatus(facts({ persistedStatus: "cancelled", subtaskStatuses: ["pending"] }))).toBe("cancelled")
    expect(deriveTaskStatus(facts({ persistedStatus: "failed", subtaskStatuses: ["running"] }))).toBe("failed")
  })
})

describe("isTaskExecutionEligible", () => {
  it("impede a fila para tarefa pausada sem inventar um status", () => {
    expect(isTaskExecutionEligible("ready", "2026-09-09T04:58:00.000Z")).toBe(false)
    expect(isTaskExecutionEligible("ready", null)).toBe(true)
  })
})
