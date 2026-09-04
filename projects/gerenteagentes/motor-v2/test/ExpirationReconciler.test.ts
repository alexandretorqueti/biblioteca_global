import { describe, expect, it, vi } from "vitest"
import { ExpirationReconciler } from "../src/reconciler/ExpirationReconciler.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

function mockDb(responses: QueryResult[]): Db {
  const db: Db = {
    query: vi.fn().mockImplementation(async () => responses.shift() ?? { rows: [], affectedRows: 0, insertId: 0 }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: Db) => Promise<unknown>) => fn(db)),
  }
  return db
}

describe("ExpirationReconciler", () => {
  it("reconhece lease ativo pelo owner_id da tarefa, sem depender do formato do execution_id", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const orphanQuery = String(vi.mocked(db.query).mock.calls[2]?.[0])
    expect(orphanQuery).toContain("r.owner_id = CAST(t.id AS CHAR)")
    expect(orphanQuery).toContain("r.owner_id = t.external_id")
    expect(orphanQuery).not.toContain("r.execution_id LIKE")
  })

  it("retoma tarefa órfã com plano sem alterar subtarefas verificadas", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ id: 41, external_id: "task-41", status: "running", has_subtasks: 1 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[3]?.[0])).toContain("status IN ('running', 'delivered', 'verifying', 'rejected')")
    expect(calls[3]?.[1]).toEqual(["41"])
    expect(calls[4]?.[1]).toEqual(["ready", "41"])
  })

  it("retoma análise órfã como planned, sem replanejar tarefas que já têm subtarefas", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ id: 42, external_id: "task-42", status: "analyzing", has_subtasks: 0 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const calls = vi.mocked(db.query).mock.calls
    expect(calls).toHaveLength(4)
    expect(calls[3]?.[1]).toEqual(["planned", "42"])
  })

  it("repara verified com retorno exato sem resposta e deixa a tarefa pai pronta", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ tarefa_id: 763 }], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[1]?.[0])).toContain("s.status = 'verified'")
    expect(calls[2]?.[1]).toEqual(["The agent run failed before producing a reply."])
    expect(calls[3]?.[1]).toEqual([763])
  })
})
