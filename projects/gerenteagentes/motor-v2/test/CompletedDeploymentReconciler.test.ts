import { describe, expect, it, vi } from "vitest"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"
import { CompletedDeploymentReconciler, type CompletedDeploymentReconciliationCandidate } from "../src/reconciliation/CompletedDeploymentReconciler.js"

const candidate: CompletedDeploymentReconciliationCandidate = {
  tarefaId: 42,
  externalId: "task-42",
  tipo: "desenvolvimento",
  derivedStatus: "completed",
  integrationConfirmed: true,
  gitConfirmed: true,
  repoPath: "/repo/projects/app",
}

function database(existing: string | null = null): Db & { queries: string[]; rows: string | null } {
  const db = {
    queries: [] as string[],
    rows: existing,
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      void params
      this.queries.push(sql)
      if (sql.startsWith("SELECT")) return { rows: this.rows ? [{ status: this.rows }] : [], affectedRows: 0, insertId: 0 }
      this.rows = "succeeded"
      return { rows: [], affectedRows: 1, insertId: 1 }
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> { return fn(this) },
  }
  return db
}

describe("CompletedDeploymentReconciler", () => {
  it("insere exatamente um succeeded para candidato confirmado", async () => {
    const db = database()
    const report = await new CompletedDeploymentReconciler(db).reconcile([candidate])
    expect(report.inserted).toHaveLength(1)
    expect(db.rows).toBe("succeeded")
    expect(db.queries[1]).toContain("INSERT INTO deploy_requests")
    expect(db.queries[1]).toContain("ON DUPLICATE KEY UPDATE")
  })

  it("preserva registro existente e conflito sem escrever", async () => {
    const db = database("failed")
    const report = await new CompletedDeploymentReconciler(db).reconcile([
      candidate,
      { ...candidate, tarefaId: 43, conflictingEvidence: true },
    ])
    expect(report.preserved[0]?.existingStatus).toBe("failed")
    expect(report.skipped[0]?.action).toBe("skipped_conflict")
    expect(db.queries.filter((sql) => sql.startsWith("INSERT")).length).toBe(0)
  })

  it("ignora categoria ou status derivado incompatível", async () => {
    const db = database()
    const report = await new CompletedDeploymentReconciler(db).reconcile([
      { ...candidate, tipo: "automacao" },
      { ...candidate, tarefaId: 43, derivedStatus: "deployed" },
    ])
    expect(report.skipped).toHaveLength(2)
    expect(db.queries).toHaveLength(0)
  })

  it("propaga falha da transação para impedir resultado parcial", async () => {
    const db = database()
    const transaction = vi.spyOn(db, "transaction").mockImplementation(async () => { throw new Error("rollback") })
    await expect(new CompletedDeploymentReconciler(db).reconcile([candidate])).rejects.toThrow("rollback")
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(db.rows).toBeNull()
  })
})
