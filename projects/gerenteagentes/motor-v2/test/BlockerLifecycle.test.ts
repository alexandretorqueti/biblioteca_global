/**
 * Testes do ciclo de vida de bloqueios.
 * @vitest-environment node
 */
import { describe, expect, it, vi } from "vitest"
import { BlockerLifecycle } from "../src/policies/BlockerLifecycle.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

function createMockDb(): Db & { queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  return {
    queries,
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql: String(sql), params: params ?? [] })
      return { rows: [], affectedRows: 1, insertId: 42 } satisfies QueryResult
    }),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn({} as Db)),
  }
}

describe("BlockerLifecycle", () => {
  describe("openBlocker", () => {
    it("insere bloqueio com campos estruturados da migration 0026", async () => {
      const db = createMockDb()
      const lifecycle = new BlockerLifecycle(db)
      const blockedAt = new Date("2026-09-10T10:00:00Z")

      const id = await lifecycle.openBlocker({
        tarefaId: 100,
        subtarefaId: 200,
        blockReason: "blocked_environment",
        blockCommand: "npm run build",
        blockExcerpt: "ENOENT: no such file",
        blockedAt,
        category: "environment",
        severity: "high",
        ownerId: "agent-programador",
        recurrenceFingerprint: "env:enoent:abc123",
      })

      expect(id).toBe(42)
      expect(db.queries).toHaveLength(1)
      const sql = db.queries[0]!.sql
      expect(sql).toContain("INSERT INTO bloqueios")
      expect(sql).toContain("category")
      expect(sql).toContain("severity")
      expect(sql).toContain("owner_id")
      expect(sql).toContain("recurrence_fingerprint")
      const params = db.queries[0]!.params
      expect(params).toContain(100)
      expect(params).toContain(200)
      expect(params).toContain("blocked_environment")
      expect(params).toContain("env:enoent:abc123")
    })
  })

  describe("resolveBlocker", () => {
    it("atualiza resolved_at e resolution do bloqueio", async () => {
      const db = createMockDb()
      const lifecycle = new BlockerLifecycle(db)
      const resolvedAt = new Date("2026-09-10T11:00:00Z")

      const resolved = await lifecycle.resolveBlocker({
        blockerId: 42,
        resolvedAt,
        resolution: "Dependência instalada manualmente",
        rootCause: "Lockfile desatualizado",
        category: "dependency",
        severity: "medium",
        ownerId: "human-alexandre",
      })

      expect(resolved).toBe(true)
      const sql = db.queries[0]!.sql
      expect(sql).toContain("UPDATE bloqueios")
      expect(sql).toContain("resolved_at = ?")
      expect(sql).toContain("resolution = ?")
      expect(sql).toContain("root_cause = ?")
      expect(sql).toContain("WHERE id = ? AND resolved_at IS NULL")
    })

    it("retorna false quando bloqueio já está resolvido", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
      const lifecycle = new BlockerLifecycle(db)

      const resolved = await lifecycle.resolveBlocker({
        blockerId: 42,
        resolvedAt: new Date(),
        resolution: "Já resolvido",
      })

      expect(resolved).toBe(false)
    })
  })

  describe("resolveAllForTask", () => {
    it("resolve todos os bloqueios abertos de uma tarefa", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
        db.queries.push({ sql: String(sql), params: params ?? [] })
        return { rows: [], affectedRows: 3, insertId: 0 } satisfies QueryResult
      })
      const lifecycle = new BlockerLifecycle(db)

      const count = await lifecycle.resolveAllForTask(100, new Date(), "Tarefa retomada manualmente")

      expect(count).toBe(3)
      const sql = db.queries[0]!.sql
      expect(sql).toContain("UPDATE bloqueios SET resolved_at")
      expect(sql).toContain("WHERE tarefa_id = ? AND resolved_at IS NULL")
    })
  })

  describe("computeBlockedTimeSeconds", () => {
    it("soma intervalos de bloqueio usando TIMESTAMPDIFF", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
        db.queries.push({ sql: String(sql), params: params ?? [] })
        return {
          rows: [{ total_blocked_seconds: 3600 }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      })
      const lifecycle = new BlockerLifecycle(db)

      const seconds = await lifecycle.computeBlockedTimeSeconds(100)

      expect(seconds).toBe(3600)
      const sql = db.queries[0]!.sql
      expect(sql).toContain("TIMESTAMPDIFF(SECOND, blocked_at, COALESCE(resolved_at, NOW()))")
    })
  })

  describe("findRecurrences", () => {
    it("busca bloqueios pelo fingerprint de recorrência", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockResolvedValue({
        rows: [
          { id: 1, tarefa_id: 100, blocked_at: "2026-09-01T10:00:00Z", resolved_at: "2026-09-01T11:00:00Z", category: "env" },
          { id: 2, tarefa_id: 101, blocked_at: "2026-09-05T10:00:00Z", resolved_at: null, category: "env" },
        ],
        affectedRows: 2,
        insertId: 0,
      } satisfies QueryResult)
      const lifecycle = new BlockerLifecycle(db)

      const recurrences = await lifecycle.findRecurrences("env:enoent:abc123")

      expect(recurrences).toHaveLength(2)
      expect(recurrences[0]!.resolvedAt).toBeInstanceOf(Date)
      expect(recurrences[1]!.resolvedAt).toBeNull()
    })
  })
})
