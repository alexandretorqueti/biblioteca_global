import { describe, expect, it, vi } from "vitest"
import { verifyPromotionGate } from "../src/promotion-gate/PromotionGateVerifier.js"
import { planPromotionRecovery } from "../src/promotion-gate/PromotionRecoveryPlanner.js"
import { createPromotionCorrectionSubtask } from "../src/planning/CorrectionSubtaskStore.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

describe("verifyPromotionGate", () => {
  it("detecta migration fora do journal e coluna sem migration", () => {
    const report = verifyPromotionGate({
      journalContent: JSON.stringify({ entries: [{ tag: "0028_task_sessions" }] }),
      migrations: [{ path: "migrations/0028_task_sessions.sql", content: "CREATE TABLE task_sessions (id int)" }, { path: "migrations/0029_plan_proposals.sql", content: "CREATE TABLE plan_proposals (id int)" }],
      requiredColumns: [{ table: "projeto_chats", column: "author", source: "ClarificationStore.ts" }],
    })
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.fingerprint)).toContain("migration-not-journaled:0029_plan_proposals")
    expect(report.issues.map((issue) => issue.fingerprint)).toContain("missing-column-migration:projeto_chats.author")
  })

  it("aceita contratos presentes em create e alter table", () => {
    const report = verifyPromotionGate({
      journalContent: JSON.stringify({ entries: [{ tag: "0029_chat_author" }] }),
      migrations: [{ path: "migrations/0029_chat_author.sql", content: "ALTER TABLE projeto_chats ADD COLUMN author varchar(200);" }],
      requiredColumns: [{ table: "projeto_chats", column: "author", source: "schema.ts" }],
    })
    expect(report).toEqual({ ok: true, issues: [] })
  })
})

describe("recuperação de promoção", () => {
  it("planeja uma corretiva limitada e idempotente", async () => {
    const request = planPromotionRecovery([{ kind: "migration_journal", fingerprint: "migration-not-journaled:0029_plan", message: "Migration ausente no journal", evidence: "0029_plan.sql" }])
    expect(request?.scope).toContain("sem ampliar o escopo funcional")
    const responses: QueryResult[] = [{ rows: [{ id: 7 }], affectedRows: 0, insertId: 0 }, { rows: [], affectedRows: 0, insertId: 0 }, { rows: [{ next_seq: 4 }], affectedRows: 0, insertId: 0 }, { rows: [], affectedRows: 1, insertId: 9 }]
    const db: Db = { query: vi.fn(async () => responses.shift() ?? { rows: [], affectedRows: 0, insertId: 0 }), transaction: vi.fn(async (fn) => fn(db)) }
    await expect(createPromotionCorrectionSubtask(db, "task-7", request!)).resolves.toEqual({ created: true })
    expect(vi.mocked(db.query).mock.calls.map(([sql]) => String(sql)).some((sql) => sql.includes("INSERT INTO subtarefas"))).toBe(true)
  })
})
