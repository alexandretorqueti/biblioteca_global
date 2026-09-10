import { describe, expect, it } from "vitest"
import { deriveTaskStatus, isTaskExecutionEligible } from "../src/policies/DerivedTaskStatus.js"

const facts = (overrides: Partial<Parameters<typeof deriveTaskStatus>[0]> = {}) => ({
  hasPendingClarification: false,
  hasActiveBlocker: false,
  analysisInProgress: false,
  hasPersistedPlan: false,
  subtaskStatuses: [],
  deploySucceeded: false,
  deployFailed: false,
  integrationConfirmed: false,
  pausedAt: null,
  resourceWaitKey: null,
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

  // Bug 802/803: Tarefas pausadas devem mostrar "paused" mesmo com clarificação pendente
  it("prioriza pausa sobre clarificação pendente", () => {
    expect(deriveTaskStatus(facts({
      hasPendingClarification: true,
      pausedAt: "2026-09-10T10:00:00.000Z",
      subtaskStatuses: ["verified"],
    }))).toBe("paused")
  })

  it("prioriza pausa sobre bloqueio de deploy", () => {
    expect(deriveTaskStatus(facts({
      hasActiveBlocker: true,
      pausedAt: "2026-09-10T10:00:00.000Z",
      subtaskStatuses: ["verified"],
    }))).toBe("paused")
  })

  // Bug 801: Subtarefas completas + deploy falhado = completed (não blocked)
  it("retorna completed quando todas subtarefas aprovadas mas deploy falhou", () => {
    expect(deriveTaskStatus(facts({
      subtaskStatuses: ["verified", "superseded"],
      integrationConfirmed: true,
      deployFailed: true,
      hasActiveBlocker: true, // bloqueio de deploy
    }))).toBe("completed")
  })

  it("retorna completed quando todas subtarefas aprovadas e deploy falhou sem integração confirmada", () => {
    expect(deriveTaskStatus(facts({
      subtaskStatuses: ["verified"],
      integrationConfirmed: false,
      deployFailed: true,
      hasActiveBlocker: true,
    }))).toBe("completed")
  })

  it("não retorna paused quando resourceWaitKey está preenchido (aguardando recurso)", () => {
    expect(deriveTaskStatus(facts({
      pausedAt: "2026-09-10T10:00:00.000Z",
      resourceWaitKey: "gpu:main",
      subtaskStatuses: ["pending"],
    }))).toBe("ready")
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
