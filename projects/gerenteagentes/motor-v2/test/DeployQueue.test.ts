/**
 * Fila persistente de deploy: publicação somente com o Motor ocioso e em lote.
 * @vitest-environment node
 */
import { describe, expect, it, vi } from "vitest"
import type { Db, QueryResult, TaskRepository } from "../src/shared/types/infrastructure.js"
import { ResourceLeaseService } from "../src/resources/ResourceLeaseService.js"
import { shellQuote, TaskCoordinator } from "../src/coordinator/TaskCoordinator.js"

function setup() {
  const db: Db = {
    query: vi.fn().mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn(db)),
  }
  const repository: TaskRepository = {
    getTask: vi.fn().mockResolvedValue(null),
    saveTask: vi.fn().mockResolvedValue(undefined),
  }
  const coordinator = new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 })
  return { db, repository, coordinator }
}

type Internals = {
  activeWorkers: Map<string, unknown>
  activeDeployments: Map<string, unknown>
  processDeployQueue(): Promise<void>
  reconcileRunningDeploys(): Promise<void>
  recoverCompletedTasksWithoutDeploy(): Promise<void>
  dispatchDeployBatch(repoPath: string, batchId: string, taskIds: string[]): void
  readRemoteDeployStatus(batchId: string): string | null
}

describe("fila de deploy", () => {
  it("cita aspas simples sem introduzir aspas literais no comando remoto", () => {
    expect(shellQuote("/tmp/arquivo com 'aspas'"))
      .toBe("'/tmp/arquivo com '\"'\"'aspas'\"'\"''")
  })

  it("não inicia deploy enquanto houver worker ativo", async () => {
    const { db, coordinator } = setup()
    const internal = coordinator as unknown as Internals
    internal.activeWorkers.set("exec-1", {})
    vi.spyOn(internal, "reconcileRunningDeploys").mockResolvedValue()
    const dispatch = vi.spyOn(internal, "dispatchDeployBatch").mockImplementation(() => undefined)

    await internal.processDeployQueue()

    expect(dispatch).not.toHaveBeenCalled()
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).toContain("t.status = 'completed'")
  })

  it("não inicia deploy quando o banco ainda registra trabalho ativo após reinício", async () => {
    const { db, coordinator } = setup()
    const internal = coordinator as unknown as Internals
    vi.spyOn(internal, "reconcileRunningDeploys").mockResolvedValue()
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
      .mockResolvedValueOnce({ rows: [{ busy: 1 }], affectedRows: 0, insertId: 0 })
    const dispatch = vi.spyOn(internal, "dispatchDeployBatch").mockImplementation(() => undefined)

    await internal.processDeployQueue()

    expect(dispatch).not.toHaveBeenCalled()
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it("agrupa tarefas pendentes do mesmo repositório em um único deploy", async () => {
    const { db, coordinator } = setup()
    const internal = coordinator as unknown as Internals
    vi.spyOn(internal, "reconcileRunningDeploys").mockResolvedValue()
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
      .mockResolvedValueOnce({ rows: [{ busy: 0 }], affectedRows: 0, insertId: 0 })
      .mockResolvedValueOnce({
        rows: [
          { id: 1, repo_path: "/repo/projeto", task_id: "task-770" },
          { id: 2, repo_path: "/repo/projeto", task_id: "task-771" },
          { id: 3, repo_path: "/outro/projeto", task_id: "task-900" },
        ], affectedRows: 0, insertId: 0,
      })
      .mockResolvedValueOnce({ rows: [], affectedRows: 2, insertId: 0 })
    const dispatch = vi.spyOn(internal, "dispatchDeployBatch").mockImplementation(() => undefined)

    await internal.processDeployQueue()

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toBe("/repo/projeto")
    expect(dispatch.mock.calls[0]?.[2]).toEqual(["task-770", "task-771"])
    expect(internal.activeDeployments.size).toBe(2)
  })

  it("só marca tarefas como deployed após confirmar sucesso no host", async () => {
    const { db, coordinator } = setup()
    const internal = coordinator as unknown as Internals
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        { batch_id: "deploy-lote", started_at: new Date().toISOString(), task_id: "task-770" },
        { batch_id: "deploy-lote", started_at: new Date().toISOString(), task_id: "task-771" },
      ], affectedRows: 0, insertId: 0,
    })
    vi.spyOn(internal, "readRemoteDeployStatus").mockReturnValue("success")

    await internal.reconcileRunningDeploys()

    const sql = vi.mocked(db.query).mock.calls.map(([query]) => String(query)).join("\n")
    expect(sql).toContain("status = 'succeeded'")
    expect(sql).toContain("t.status = 'deployed'")
    expect(internal.activeDeployments.size).toBe(0)
  })

  it("recupera desenvolvimento concluído que nunca entrou na fila", async () => {
    const { db, coordinator } = setup()
    const internal = coordinator as unknown as Internals
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 2, insertId: 0 })

    await internal.recoverCompletedTasksWithoutDeploy()

    const sql = String(vi.mocked(db.query).mock.calls[0]?.[0])
    expect(sql).toContain("t.tipo = 'desenvolvimento'")
    expect(sql).toContain("t.status = 'completed'")
    expect(sql).toContain("dr.id IS NULL")
  })

  it("bloqueia as tarefas e registra o motivo quando o deploy falha", async () => {
    const { db, coordinator } = setup()
    const internal = coordinator as unknown as Internals & {
      failDeployBatch(batchId: string, error: string, taskIds: string[]): Promise<void>
    }

    await internal.failDeployBatch("deploy-falhou", "healthcheck da API falhou", ["task-770"])

    const calls = vi.mocked(db.query).mock.calls
    const sql = calls.map(([query]) => String(query)).join("\n")
    expect(sql).toContain("INSERT INTO bloqueios")
    expect(sql).toContain("t.status = 'blocked'")
    expect(calls.some(([, params]) => Array.isArray(params) && params.includes("healthcheck da API falhou"))).toBe(true)
  })
})
