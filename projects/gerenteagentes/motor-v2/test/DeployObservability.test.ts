/**
 * Testes da observabilidade de deploy e pós-deploy.
 * @vitest-environment node
 */
import { describe, expect, it, vi } from "vitest"
import { DeployObservability, deployCorrelationId } from "../src/policies/DeployObservability.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

function createMockDb(): Db & { queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  return {
    queries,
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql: String(sql), params: params ?? [] })
      return { rows: [], affectedRows: 1, insertId: 0 } satisfies QueryResult
    }),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn({} as Db)),
  }
}

describe("DeployObservability", () => {
  describe("recordDeployResult", () => {
    it("grava deployed_at quando deploy succeeded", async () => {
      const db = createMockDb()
      const obs = new DeployObservability(db)
      const deployedAt = new Date("2026-09-10T12:00:00Z")

      await obs.recordDeployResult({
        taskId: 100,
        batchId: "deploy-abc",
        outcome: "succeeded",
        deployedAt,
      })

      const sql = db.queries[0]!.sql
      expect(sql).toContain("UPDATE tarefas SET deployed_at = ?")
      expect(sql).toContain("smoke_test_ok = NULL")
      expect(db.queries[0]!.params).toContain(deployedAt)
      expect(db.queries[0]!.params).toContain(100)
    })

    it("limpa deployed_at quando deploy failed", async () => {
      const db = createMockDb()
      const obs = new DeployObservability(db)

      await obs.recordDeployResult({
        taskId: 100,
        batchId: "deploy-abc",
        outcome: "failed",
        error: "healthcheck failed",
      })

      const sql = db.queries[0]!.sql
      expect(sql).toContain("deployed_at = NULL")
      expect(sql).toContain("smoke_test_ok = NULL")
    })

    it("NÃO marca smoke_test_ok como true ao registrar deploy succeeded", async () => {
      const db = createMockDb()
      const obs = new DeployObservability(db)

      await obs.recordDeployResult({
        taskId: 100,
        batchId: "deploy-abc",
        outcome: "succeeded",
      })

      const sql = db.queries[0]!.sql
      // Deploy sem smoke não conta como confiável
      expect(sql).toContain("smoke_test_ok = NULL")
      expect(sql).not.toContain("smoke_test_ok = true")
      expect(sql).not.toContain("smoke_test_ok = 1")
    })
  })

  describe("recordSmokeTest", () => {
    it("grava smoke_test_ok = true quando smoke passa", async () => {
      const db = createMockDb()
      const obs = new DeployObservability(db)
      const smokeTestAt = new Date("2026-09-10T12:05:00Z")

      await obs.recordSmokeTest({
        taskId: 100,
        outcome: "passed",
        smokeTestAt,
      })

      const sql = db.queries[0]!.sql
      expect(sql).toContain("smoke_test_at = ?")
      expect(sql).toContain("smoke_test_ok = ?")
      expect(db.queries[0]!.params).toContain(true)
    })

    it("grava smoke_test_ok = false quando smoke falha", async () => {
      const db = createMockDb()
      const obs = new DeployObservability(db)

      await obs.recordSmokeTest({
        taskId: 100,
        outcome: "failed",
        smokeTestAt: new Date(),
      })

      expect(db.queries[0]!.params).toContain(false)
    })
  })

  describe("recordRollback", () => {
    it("grava rollback_at, incident_id e customer_impact", async () => {
      const db = createMockDb()
      const obs = new DeployObservability(db)
      const rollbackAt = new Date("2026-09-10T13:00:00Z")

      await obs.recordRollback({
        taskId: 100,
        rollbackAt,
        incidentId: "INC-2026-042",
        customerImpact: true,
        reason: "API retornando 500",
      })

      const sql = db.queries[0]!.sql
      expect(sql).toContain("rollback_at = ?")
      expect(sql).toContain("incident_id = ?")
      expect(sql).toContain("customer_impact = ?")
      expect(db.queries[0]!.params).toContain("INC-2026-042")
      expect(db.queries[0]!.params).toContain(true)
    })
  })

  describe("isDeployReliable", () => {
    it("retorna true somente quando smoke_test_ok é true", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockResolvedValue({
        rows: [{ smoke_test_ok: true }],
        affectedRows: 1,
        insertId: 0,
      } satisfies QueryResult)
      const obs = new DeployObservability(db)

      expect(await obs.isDeployReliable(100)).toBe(true)
    })

    it("retorna false quando smoke_test_ok é NULL (não verificado)", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockResolvedValue({
        rows: [{ smoke_test_ok: null }],
        affectedRows: 1,
        insertId: 0,
      } satisfies QueryResult)
      const obs = new DeployObservability(db)

      expect(await obs.isDeployReliable(100)).toBe(false)
    })

    it("retorna false quando smoke_test_ok é false", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockResolvedValue({
        rows: [{ smoke_test_ok: false }],
        affectedRows: 1,
        insertId: 0,
      } satisfies QueryResult)
      const obs = new DeployObservability(db)

      expect(await obs.isDeployReliable(100)).toBe(false)
    })
  })

  describe("computeDeployReliability", () => {
    it("calcula taxa de confiabilidade pós-deploy", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockResolvedValue({
        rows: [{ total: 10, reliable: 7 }],
        affectedRows: 1,
        insertId: 0,
      } satisfies QueryResult)
      const obs = new DeployObservability(db)

      const result = await obs.computeDeployReliability()

      expect(result).toEqual({ reliable: 7, total: 10, rate: 0.7 })
    })

    it("retorna null quando não há deploys", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockResolvedValue({
        rows: [{ total: 0, reliable: 0 }],
        affectedRows: 1,
        insertId: 0,
      } satisfies QueryResult)
      const obs = new DeployObservability(db)

      const result = await obs.computeDeployReliability()

      expect(result).toBeNull()
    })

    it("filtra por projeto quando projectId é fornecido", async () => {
      const db = createMockDb()
      vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
        db.queries.push({ sql: String(sql), params: params ?? [] })
        return {
          rows: [{ total: 5, reliable: 4 }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      })
      const obs = new DeployObservability(db)

      await obs.computeDeployReliability(640)

      const sql = db.queries[0]!.sql
      expect(sql).toContain("t.projeto_id = ?")
      expect(db.queries[0]!.params).toContain(640)
    })
  })
})

describe("deployCorrelationId", () => {
  it("gera correlation_id com batchId e sufixo aleatório", () => {
    const id = deployCorrelationId("deploy-abc-123")
    expect(id).toMatch(/^deploy:deploy-abc-123:[0-9a-f]{8}$/)
  })

  it("gera IDs diferentes para chamadas diferentes", () => {
    const id1 = deployCorrelationId("deploy-abc")
    const id2 = deployCorrelationId("deploy-abc")
    expect(id1).not.toBe(id2)
  })
})
