import { describe, expect, it, vi } from "vitest"
import { ExpirationReconciler } from "../src/reconciler/ExpirationReconciler.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

function mockDb(responses: QueryResult[]): Db {
  return {
    query: vi.fn().mockImplementation(async () => responses.shift() ?? { rows: [], affectedRows: 0, insertId: 0 }),
    transaction: vi.fn(),
  }
}

describe("ExpirationReconciler", () => {
  it("retoma tarefa órfã com plano sem alterar subtarefas verificadas", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ id: 41, external_id: "task-41", status: "running", has_subtasks: 1 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[2]?.[0])).toContain("status IN ('running', 'delivered', 'verifying', 'rejected')")
    expect(calls[2]?.[1]).toEqual(["41"])
    expect(calls[3]?.[1]).toEqual(["ready", "41"])
  })

  it("retoma análise órfã como planned, sem replanejar tarefas que já têm subtarefas", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ id: 42, external_id: "task-42", status: "analyzing", has_subtasks: 0 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const calls = vi.mocked(db.query).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[2]?.[1]).toEqual(["planned", "42"])
  })
})
