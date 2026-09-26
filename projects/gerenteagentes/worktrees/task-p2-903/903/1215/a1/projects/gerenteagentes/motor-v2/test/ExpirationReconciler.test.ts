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
  it("reconhece worker ativo pela presença persistida, sem exigir lease exclusivo", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const orphanQuery = String(vi.mocked(db.query).mock.calls[2]?.[0])
    expect(orphanQuery).toContain("motor_active_executions")
    expect(orphanQuery).toContain("e.tarefa_id = t.id")
    expect(orphanQuery).not.toContain("execution_resources")
  })

  it("protege análise e subtarefa running nos três detectores de órfãos", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const queries = vi.mocked(db.query).mock.calls.map(([sql]) => String(sql))
    const presenceQueries = queries.filter((sql) => sql.includes("motor_active_executions"))
    expect(presenceQueries).toHaveLength(3)
    expect(presenceQueries.some((sql) => sql.includes("e.subtarefa_id = s.id"))).toBe(true)
    expect(presenceQueries.every((sql) => !sql.includes("execution_resources"))).toBe(true)
  })

  it("retoma tarefa órfã com plano sem alterar subtarefas verificadas", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ id: 41, external_id: "task-41", status: "running", has_subtasks: 1 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 }, // recoverOrphanedAnalysis
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[3]?.[0])).toContain("status IN ('running', 'delivered', 'verifying', 'rejected')")
    expect(calls[3]?.[1]).toEqual(["41"])
    expect(calls).toHaveLength(6)
  })

  it("retoma análise órfã como planned, sem replanejar tarefas que já têm subtarefas", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ id: 42, external_id: "task-42", status: "analyzing", has_subtasks: 0 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 }, // recoverOrphanedAnalysis
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const calls = vi.mocked(db.query).mock.calls
    expect(calls).toHaveLength(5)
  })

  it("recupera subtarefa running órfã mesmo quando a tarefa pai está planned", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ subtask_id: 829, tarefa_id: 758, external_id: "task-758" }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 }, // recoverOrphanedAnalysis
    ])
    await new ExpirationReconciler({ db }).reconcile()
    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[3]?.[0])).toContain("s.status = 'running'")
    expect(String(calls[4]?.[0])).toContain("status = 'pending'")
    expect(calls[4]?.[1]).toEqual([829])
    expect(calls).toHaveLength(6)
  })

  it("repara verified com retorno exato sem resposta e deixa a tarefa pai pronta", async () => {
    const db = mockDb([
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [{ tarefa_id: 763 }], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 }, // recoverOrphanedAnalysis
    ])

    await new ExpirationReconciler({ db }).reconcile()

    const calls = vi.mocked(db.query).mock.calls
    expect(String(calls[1]?.[0])).toContain("s.status = 'verified'")
    expect(calls[2]?.[1]).toEqual(["The agent run failed before producing a reply."])
    expect(calls).toHaveLength(6)
  })
})
