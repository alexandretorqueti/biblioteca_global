import { describe, expect, it, vi } from "vitest"
import { hasPersistedPlan, persistPlan } from "../src/planning/PlanPersistence.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

function mockDb(responses: QueryResult[]): Db {
  const db: Db = {
    query: vi.fn().mockImplementation(async () => responses.shift() ?? { rows: [], affectedRows: 0, insertId: 0 }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: Db) => Promise<unknown>) => fn(db)),
  }
  return db
}

describe("persistPlan", () => {
  it("persiste todas as subtarefas em uma transação sem apagar um plano anterior", async () => {
    const db = mockDb([
      { rows: [{ id: 71 }], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 0, insertId: 0 },
      { rows: [], affectedRows: 1, insertId: 1 },
      { rows: [], affectedRows: 1, insertId: 2 },
    ])

    const result = await persistPlan(db, "task-71", [
      { seq: 1, titulo: "Preparar", scope: "Preparar a base necessária para executar a tarefa.", acceptanceCriteria: ["base pronta", "sem erro"], deliverables: ["configuração"], requirementsCovered: ["REQ-1"], dependsOn: [] },
      { seq: 2, titulo: "Executar", scope: "Executar a alteração principal e validar o resultado.", acceptanceCriteria: ["resultado verde", "fluxo validado"], deliverables: ["implementação"], requirementsCovered: ["REQ-1"], dependsOn: [1] },
    ], { requirements: [{ id: "REQ-1", description: "entrega" }], coverage: [{ requirement: "REQ-1", coveredBy: [1, 2] }] })

    expect(result).toBe("created")
    expect(db.transaction).toHaveBeenCalledOnce()
    const sql = vi.mocked(db.query).mock.calls.map(([query]) => String(query))
    expect(sql.some((query) => query.includes("DELETE FROM subtarefas"))).toBe(false)
    expect(sql.filter((query) => query.includes("INSERT INTO subtarefas"))).toHaveLength(2)
  })

  it("preserva plano já persistido sem inserir ou apagar subtarefas", async () => {
    const db = mockDb([
      { rows: [{ id: 71 }], affectedRows: 0, insertId: 0 },
      { rows: [{ id: 99 }], affectedRows: 0, insertId: 0 },
    ])

    await expect(persistPlan(db, "task-71", [{ seq: 1, titulo: "Ignorar", scope: "Plano já persistido e não deve ser substituído.", acceptanceCriteria: ["preserva", "não insere"], deliverables: ["nenhum"], requirementsCovered: ["REQ-1"], dependsOn: [] }], { requirements: [{ id: "REQ-1", description: "preservar" }], coverage: [{ requirement: "REQ-1", coveredBy: [1] }] })).resolves.toBe("already_persisted")

    const sql = vi.mocked(db.query).mock.calls.map(([query]) => String(query))
    expect(sql.some((query) => query.includes("INSERT INTO subtarefas"))).toBe(false)
    expect(sql.some((query) => query.includes("DELETE FROM subtarefas"))).toBe(false)
  })
})

describe("hasPersistedPlan", () => {
  it("consulta o plano pela identidade externa da tarefa", async () => {
    const db = mockDb([{ rows: [{ has_plan: 1 }], affectedRows: 0, insertId: 0 }])

    await expect(hasPersistedPlan(db, "task-71")).resolves.toBe(true)
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).toContain("EXISTS")
  })
})
