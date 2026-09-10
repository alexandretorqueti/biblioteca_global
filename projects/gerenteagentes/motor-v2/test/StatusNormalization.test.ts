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
})
