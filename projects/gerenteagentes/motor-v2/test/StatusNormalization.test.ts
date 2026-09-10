/**
 * Testes do módulo de normalização de status.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest"
import {
  normalizeTaskStatus,
  isCanonicalTaskStatus,
  isLegacyTaskStatus,
  assertWritableTaskStatus,
  normalizeTaskRow,
  normalizeTaskRows,
  normalizeSubtaskRow,
  normalizeSubtaskRows,
  isSupersededWithSuccessor,
  computeSubtaskDenominator,
} from "../src/shared/status-normalization.js"

describe("status-normalization", () => {
  describe("normalizeTaskStatus", () => {
    it("normaliza deployada para deployed", () => {
      expect(normalizeTaskStatus("deployada")).toBe("deployed")
    })

    it("normaliza finalizada para completed", () => {
      expect(normalizeTaskStatus("finalizada")).toBe("completed")
    })

    it("normaliza aborted para cancelled", () => {
      expect(normalizeTaskStatus("aborted")).toBe("cancelled")
    })

    it("mantém status canônicos inalterados", () => {
      expect(normalizeTaskStatus("deployed")).toBe("deployed")
      expect(normalizeTaskStatus("running")).toBe("running")
      expect(normalizeTaskStatus("completed")).toBe("completed")
      expect(normalizeTaskStatus("blocked")).toBe("blocked")
    })
  })

  describe("isCanonicalTaskStatus", () => {
    it("retorna true para status canônicos", () => {
      expect(isCanonicalTaskStatus("deployed")).toBe(true)
      expect(isCanonicalTaskStatus("running")).toBe(true)
      expect(isCanonicalTaskStatus("completed")).toBe(true)
    })

    it("retorna false para status legados", () => {
      expect(isCanonicalTaskStatus("deployada")).toBe(false)
      expect(isCanonicalTaskStatus("finalizada")).toBe(false)
      expect(isCanonicalTaskStatus("aborted")).toBe(false)
    })
  })

  describe("isLegacyTaskStatus", () => {
    it("identifica status legados", () => {
      expect(isLegacyTaskStatus("deployada")).toBe(true)
      expect(isLegacyTaskStatus("finalizada")).toBe(true)
      expect(isLegacyTaskStatus("aborted")).toBe(true)
    })

    it("retorna false para canônicos", () => {
      expect(isLegacyTaskStatus("deployed")).toBe(false)
      expect(isLegacyTaskStatus("running")).toBe(false)
    })
  })

  describe("assertWritableTaskStatus", () => {
    it("permite status canônicos", () => {
      expect(assertWritableTaskStatus("deployed")).toBe("deployed")
      expect(assertWritableTaskStatus("running")).toBe("running")
    })

    it("lança erro para status legados", () => {
      expect(() => assertWritableTaskStatus("deployada")).toThrow(/legado/)
      expect(() => assertWritableTaskStatus("finalizada")).toThrow(/legado/)
    })

    it("lança erro para status desconhecidos", () => {
      expect(() => assertWritableTaskStatus("unknown_status")).toThrow(/desconhecido/)
    })
  })

  describe("normalizeTaskRow", () => {
    it("normaliza o status de uma linha", () => {
      const row = { id: 1, status: "deployada", title: "Test" }
      const normalized = normalizeTaskRow(row)
      expect(normalized.status).toBe("deployed")
      expect(normalized.id).toBe(1)
      expect(normalized.title).toBe("Test")
    })

    it("não altera a linha original", () => {
      const row = { id: 1, status: "deployada" }
      normalizeTaskRow(row)
      expect(row.status).toBe("deployada")
    })
  })

  describe("normalizeTaskRows", () => {
    it("normaliza múltiplas linhas", () => {
      const rows = [
        { id: 1, status: "deployada" },
        { id: 2, status: "running" },
        { id: 3, status: "finalizada" },
      ]
      const normalized = normalizeTaskRows(rows)
      expect(normalized[0]!.status).toBe("deployed")
      expect(normalized[1]!.status).toBe("running")
      expect(normalized[2]!.status).toBe("completed")
    })
  })

  describe("normalizeSubtaskRow", () => {
    it("normaliza o status de uma subtarefa", () => {
      const row = { id: 1, status: "verified" }
      const normalized = normalizeSubtaskRow(row)
      expect(normalized.status).toBe("verified")
    })

    it("não altera a linha original", () => {
      const row = { id: 1, status: "running" }
      normalizeSubtaskRow(row)
      expect(row.status).toBe("running")
    })
  })

  describe("normalizeSubtaskRows", () => {
    it("normaliza múltiplas subtarefas", () => {
      const rows = [
        { id: 1, status: "verified" },
        { id: 2, status: "running" },
        { id: 3, status: "pending" },
      ]
      const normalized = normalizeSubtaskRows(rows)
      expect(normalized[0]!.status).toBe("verified")
      expect(normalized[1]!.status).toBe("running")
      expect(normalized[2]!.status).toBe("pending")
    })
  })

  describe("isSupersededWithSuccessor", () => {
    it("retorna true quando superseded tem sucessora", () => {
      expect(isSupersededWithSuccessor({ id: 1, status: "superseded", supersededBySubtaskId: 2 })).toBe(true)
    })

    it("retorna false quando superseded NÃO tem sucessora", () => {
      expect(isSupersededWithSuccessor({ id: 1, status: "superseded", supersededBySubtaskId: null })).toBe(false)
      expect(isSupersededWithSuccessor({ id: 1, status: "superseded" })).toBe(false)
    })

    it("retorna false para status não-superseded", () => {
      expect(isSupersededWithSuccessor({ id: 1, status: "verified", supersededBySubtaskId: 2 })).toBe(false)
      expect(isSupersededWithSuccessor({ id: 1, status: "running" })).toBe(false)
    })
  })

  describe("computeSubtaskDenominator", () => {
    it("exclui skipped sempre", () => {
      const subtasks = [
        { id: 1, status: "verified" },
        { id: 2, status: "skipped" },
        { id: 3, status: "running" },
      ]
      const result = computeSubtaskDenominator(subtasks)
      expect(result.eligibleIds).toEqual([1, 3])
      expect(result.excludedIds).toEqual([2])
      expect(result.total).toBe(2)
    })

    it("exclui superseded COM sucessora", () => {
      const subtasks = [
        { id: 1, status: "verified" },
        { id: 2, status: "superseded", supersededBySubtaskId: 3 },
        { id: 3, status: "running" },
      ]
      const result = computeSubtaskDenominator(subtasks)
      expect(result.eligibleIds).toEqual([1, 3])
      expect(result.excludedIds).toEqual([2])
      expect(result.total).toBe(2)
    })

    it("NÃO exclui superseded SEM sucessora", () => {
      const subtasks = [
        { id: 1, status: "verified" },
        { id: 2, status: "superseded", supersededBySubtaskId: null },
        { id: 3, status: "running" },
      ]
      const result = computeSubtaskDenominator(subtasks)
      expect(result.eligibleIds).toEqual([1, 2, 3])
      expect(result.excludedIds).toEqual([])
      expect(result.total).toBe(3)
    })

    it("inclui todos os status operacionais no denominador", () => {
      const subtasks = [
        { id: 1, status: "pending" },
        { id: 2, status: "running" },
        { id: 3, status: "verifying" },
        { id: 4, status: "delivered" },
        { id: 5, status: "rejected" },
        { id: 6, status: "blocked" },
        { id: 7, status: "failed" },
        { id: 8, status: "rework" },
      ]
      const result = computeSubtaskDenominator(subtasks)
      expect(result.eligibleIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(result.total).toBe(8)
    })
  })
})
