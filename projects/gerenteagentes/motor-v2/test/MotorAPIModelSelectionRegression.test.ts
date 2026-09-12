import { afterEach, describe, expect, it } from "vitest"
import { MotorAPI } from "../src/api/MotorAPI.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

const individualRows = [
  { ordem: 1, provider: "ollama", model: "m1", enabled: 1 },
  { ordem: 2, provider: "openai", model: "m2", enabled: 0 },
]

function result(rows: Record<string, unknown>[] = []): QueryResult {
  return { rows, affectedRows: 0, insertId: 0 }
}

describe("MotorAPI — regressão da configuração individual", () => {
  const apis: MotorAPI[] = []

  afterEach(async () => {
    for (const api of apis.splice(0)) await api.stop()
  })

  it("GET individual consulta somente project_model_selection e preserva legado, ordem e enabled", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const db: Db = {
      query: async (sql, params) => {
        queries.push({ sql, params })
        return result(sql.includes("FROM project_model_selection") ? individualRows : [])
      },
      transaction: async (fn) => fn(db),
    }
    const api = new MotorAPI({ port: 0, coordinator: {} as never, db })
    apis.push(api)
    await api.start()
    const address = (api as unknown as { server: { address(): { port: number } } }).server.address()

    const response = await fetch(`http://127.0.0.1:${address.port}/api/model-selection/projeto-a/DEV`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      projectKey: "projeto-a",
      tipo: "DEV",
      entries: individualRows.map((row) => ({ ...row, ordem: Number(row.ordem), enabled: Boolean(row.enabled) })),
    })
    expect(queries).toHaveLength(1)
    expect(queries[0]?.sql).toContain("FROM project_model_selection")
    expect(queries[0]?.sql).not.toContain("global_model_selection")
    expect(queries[0]?.params).toEqual(["projeto-a", "DEV"])
  })

  it("PUT individual substitui somente o par project_slug/tipo e não altera global_model_selection", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const db: Db = {
      query: async (sql, params) => {
        queries.push({ sql, params })
        return result()
      },
      transaction: async (fn) => fn(db),
    }
    const api = new MotorAPI({ port: 0, coordinator: {} as never, db })
    apis.push(api)
    await api.start()
    const address = (api as unknown as { server: { address(): { port: number } } }).server.address()
    const entries = [{ ordem: 1, provider: "provider-legado", model: "modelo-legado", enabled: true }]

    const response = await fetch(`http://127.0.0.1:${address.port}/api/model-selection/projeto-a/DEV`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ projectKey: "projeto-a", tipo: "DEV", entries })
    expect(queries.map(({ sql }) => sql)).toEqual([
      "DELETE FROM project_model_selection WHERE project_slug = ? AND tipo = ?",
      "INSERT INTO project_model_selection (project_slug, tipo, ordem, provider, model, enabled)\n           VALUES (?, ?, ?, ?, ?, ?)",
    ])
    expect(queries[0]?.params).toEqual(["projeto-a", "DEV"])
    expect(queries[1]?.params).toEqual(["projeto-a", "DEV", 1, "provider-legado", "modelo-legado", 1])
    expect(queries.some(({ sql }) => sql.includes("global_model_selection"))).toBe(false)
  })
})
