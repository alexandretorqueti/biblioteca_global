import { describe, expect, it } from "vitest"
import { TaskFactsStore } from "../src/database/TaskFactsStore.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

describe("TaskFactsStore.recoveryEligibility", () => {
  it("deriva o status sem consultar a coluna removida tarefas.status", async () => {
    const queries: string[] = []
    const result = (rows: Record<string, unknown>[] = []): QueryResult => ({ rows, affectedRows: 0, insertId: 0 })
    const db: Db = {
      query: async (sql) => {
        queries.push(sql)
        if (sql.startsWith("SELECT t.id FROM tarefas")) return result([{ id: 12 }])
        if (sql.startsWith("SELECT t.id, t.paused_at")) return result([{ id: 12, terminal_status: null, has_active_blocker: 1, deploy_succeeded: 0, deploy_failed: 0 }])
        if (sql.startsWith("SELECT s.status")) return result([{ status: "blocked" }])
        if (sql.startsWith("SELECT b.id")) return result([{ id: 3, subtarefa_id: 8, block_reason: "systemic_failure", blocked_at: "2026-09-12 00:00:00", orphan: 0 }])
        if (sql.startsWith("SELECT NULL AS id")) return result([])
        if (sql.startsWith("SELECT COUNT(*) AS total")) return result([{ total: 0 }])
        if (sql.includes("FROM execution_resources")) return result([])
        if (sql.startsWith("SELECT id, role, texto")) return result([])
        throw new Error("Consulta inesperada: " + sql)
      },
      transaction: async <T>(fn: (tx: Db) => Promise<T>) => fn(db),
    }
    const eligibility = await new TaskFactsStore(db).recoveryEligibility("12", new Date("2026-09-12T00:02:00Z"))
    expect(eligibility).toMatchObject({ state: "eligible" })
    expect(queries.some((sql) => /t\.status/.test(sql))).toBe(false)
  })
})
