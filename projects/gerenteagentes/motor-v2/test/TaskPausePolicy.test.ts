import { describe, expect, it } from "vitest"
import {
  isTaskPauseEligible,
  TASK_STATUS_NAO_PAUSAVEL,
  type PauseAllResult,
} from "../src/shared/task-statuses.js"

describe("política canônica de pausa", () => {
  it("exclui concluída, deployada e equivalentes legados", () => {
    for (const status of ["completed", "deployed", "finalizada", "deployada"]) {
      expect(TASK_STATUS_NAO_PAUSAVEL.has(status)).toBe(true)
      expect(isTaskPauseEligible(status)).toBe(false)
    }
  })

  it("não usa o conjunto genérico de status finais", () => {
    for (const status of ["failed", "cancelled", "aborted", "blocked"]) {
      expect(isTaskPauseEligible(status)).toBe(true)
    }
  })

  it("é idempotente para tarefa já pausada", () => {
    expect(isTaskPauseEligible("paused")).toBe(false)
    expect(isTaskPauseEligible("ready", new Date())).toBe(false)
    expect(isTaskPauseEligible("ready", null)).toBe(true)
  })

  it("define o contrato com as quatro categorias do lote", () => {
    const result: PauseAllResult = { paused: 1, scheduled: 2, skipped: 3, failed: 4 }
    expect(Object.keys(result)).toEqual(["paused", "scheduled", "skipped", "failed"])
  })
})
