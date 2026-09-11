import { describe, expect, it, vi } from "vitest"
import { getOrReserveTaskAnalystSession } from "../src/planning/AnalystSessionStore.js"
import type { Db } from "../src/shared/types/infrastructure.js"

function dbWith(rows: Record<string, unknown>[]): Db {
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ id: 42 }], affectedRows: 0, insertId: 0 })
    .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
    .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
    .mockResolvedValueOnce({ rows, affectedRows: 0, insertId: 0 })
  return { query, transaction: vi.fn() } as unknown as Db
}

describe("AnalystSessionStore", () => {
  it("reserva uma única sessão por tarefa e relê a chave persistida", async () => {
    const db = dbWith([{ id: 9, tarefa_id: 42, agent_id: "analyst", model: "model-a", session_key: "analysis-task-9", status: "active" }])
    const session = await getOrReserveTaskAnalystSession(db, "task-9", { agentId: "analyst", model: "model-a", sessionKey: "analysis-task-9" })
    expect(session.sessionKey).toBe("analysis-task-9")
    expect(String(vi.mocked(db.query).mock.calls[1]![0])).toContain("INSERT IGNORE")
    expect(String(vi.mocked(db.query).mock.calls[2]![0])).toContain("runtime_session_id IS NULL")
    expect(String(vi.mocked(db.query).mock.calls[3]![0])).toContain("WHERE tarefa_id = ?")
  })

  it("promove a reserva para o próximo modelo enquanto não há sessão remota", async () => {
    const db = dbWith([{ id: 9, tarefa_id: 42, agent_id: "analyst", model: "model-b", session_key: "analysis-task-9", runtime_session_id: null, status: "active" }])

    await getOrReserveTaskAnalystSession(db, "task-9", {
      agentId: "analyst",
      model: "model-b",
      sessionKey: "analysis-task-9",
    })

    expect(String(vi.mocked(db.query).mock.calls[2]![0])).toContain("model = ?")
    expect(vi.mocked(db.query).mock.calls[2]![1]).toEqual(["model-b", 42])
  })
})
