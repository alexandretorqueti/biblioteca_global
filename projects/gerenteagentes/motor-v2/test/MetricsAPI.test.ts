/**
 * Testes de integração para endpoints de métricas do MotorAPI.
 *
 * Valida:
 * - GET /api/motor/metrics — KPIs consolidados
 * - GET /api/motor/metrics/tasks — lista de tarefas com resumo
 * - Filtros por projeto, tarefa e período
 * - Data quality e diferenciação aceito vs operacional
 * - Paginação
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { MotorAPI } from "../src/api/MotorAPI.js"
import type { TaskCoordinator } from "../src/coordinator/TaskCoordinator.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

// ============================================================================
// HELPERS
// ============================================================================

function createMockCoordinator(): TaskCoordinator {
  return {
    pump: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({}),
    getTaskWithSubtasks: vi.fn().mockResolvedValue(null),
    getTasksByStatus: vi.fn().mockResolvedValue({}),
    enqueueTask: vi.fn().mockResolvedValue({ executionId: "exec-1" }),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    resumeTask: vi.fn().mockResolvedValue(undefined),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    deployTask: vi.fn().mockResolvedValue(undefined),
    answerClarification: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskCoordinator
}

interface MockQueryHandler {
  (sql: string, params?: unknown[]): QueryResult
}

function createMockDb(handler: MockQueryHandler): Db {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => handler(sql, params ?? [])),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn({} as Db)),
  }
}

/**
 * Faz uma requisição GET ao MotorAPI e retorna status + body.
 */
async function makeRequest(
  api: MotorAPI,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Usa o servidor HTTP real para testar roteamento e parsing
  const address = (api as unknown as { server: { address(): { port: number } } }).server.address()
  const port = address.port
  const url = `http://127.0.0.1:${port}${path}`

  const response = await fetch(url)
  const body = await response.json() as Record<string, unknown>
  return { status: response.status, body }
}

// ============================================================================
// TESTES: GET /api/motor/metrics
// ============================================================================

describe("GET /api/motor/metrics", () => {
  let api: MotorAPI
  let db: Db

  const base = new Date("2026-09-01T10:00:00Z")

  beforeEach(async () => {
    db = createMockDb((sql: string) => {
      // fetchSubtasks
      if (sql.includes("FROM subtarefas s")) {
        return {
          rows: [
            {
              id: 1,
              status: "verified",
              weight: 5,
              planned_start: base,
              planned_end: new Date(base.getTime() + 7200_000),
              created_at: base,
              verified_at: new Date(base.getTime() + 3600_000),
              superseded_by_subtask_id: null,
              verified_attempt: 1,
              attempt_count: 1,
              has_blocker: 0,
            },
            {
              id: 2,
              status: "running",
              weight: 3,
              planned_start: base,
              planned_end: new Date(base.getTime() + 10800_000),
              created_at: base,
              verified_at: null,
              superseded_by_subtask_id: null,
              verified_attempt: null,
              attempt_count: 1,
              has_blocker: 0,
            },
            {
              id: 3,
              status: "blocked",
              weight: 2,
              planned_start: null,
              planned_end: null,
              created_at: base,
              verified_at: null,
              superseded_by_subtask_id: null,
              verified_attempt: null,
              attempt_count: 1,
              has_blocker: 1,
            },
          ],
          affectedRows: 3,
          insertId: 0,
        } satisfies QueryResult
      }
      // fetchAttempts
      if (sql.includes("FROM execution_attempts ea")) {
        return {
          rows: [
            {
              id: 1,
              subtask_id: 1,
              attempt_number: 1,
              started_at: base,
              finished_at: new Date(base.getTime() + 3600_000),
              outcome: "verified",
              duration_ms: 3600_000,
              gate_count: 3,
            },
            {
              id: 2,
              subtask_id: 2,
              attempt_number: 1,
              started_at: base,
              finished_at: null,
              outcome: "running",
              duration_ms: null,
              gate_count: 0,
            },
          ],
          affectedRows: 2,
          insertId: 0,
        } satisfies QueryResult
      }
      // fetchGates
      if (sql.includes("FROM gate_runs gr")) {
        return {
          rows: [
            { id: 1, attempt_id: 1, gate_type: "build", status: "passed" },
            { id: 2, attempt_id: 1, gate_type: "test", status: "passed" },
            { id: 3, attempt_id: 1, gate_type: "lint", status: "failed" },
          ],
          affectedRows: 3,
          insertId: 0,
        } satisfies QueryResult
      }
      // fetchDeploys
      if (sql.includes("FROM tarefas t") && sql.includes("deployed_at")) {
        return {
          rows: [{ id: "1", deployed_at: new Date(base.getTime() + 4000_000), smoke_test_ok: true }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      // fetchBlockedTimeSeconds
      if (sql.includes("FROM bloqueios b")) {
        return {
          rows: [{ total_blocked_seconds: 1800 }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      return { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult
    })

    api = new MotorAPI({
      port: 0, // random port
      coordinator: createMockCoordinator(),
      db,
    })
    await api.start()
  })

  afterEach(async () => {
    await api.stop()
  })

  it("retorna todos os KPIs com ok=true", async () => {
    const { status, body } = await makeRequest(api, "/api/motor/metrics")

    expect(status).toBe(200)
    expect(body.ok).toBe(true)

    // KPIs presentes
    expect(body).toHaveProperty("totalWeightedScope")
    expect(body).toHaveProperty("acceptedAdvancement")
    expect(body).toHaveProperty("operationalProgress")
    expect(body).toHaveProperty("blockedItems")
    expect(body).toHaveProperty("firstAttemptApprovalRate")
    expect(body).toHaveProperty("reworkRate")
    expect(body).toHaveProperty("blockerRate")
    expect(body).toHaveProperty("medianLeadTimeSeconds")
    expect(body).toHaveProperty("totalBlockedTimeSeconds")
    expect(body).toHaveProperty("gateSuccessRate")
    expect(body).toHaveProperty("deployReliability")
    expect(body).toHaveProperty("dataQuality")
    expect(body).toHaveProperty("computedAt")
  })

  it("diferencia avanço aceito de progresso operacional", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")

    // acceptedAdvancement: 5/(5+3+2) = 0.5
    expect(body.acceptedAdvancement).toBeCloseTo(0.5)

    // operationalProgress: (verified + running + blocked) / 3 = 3/3 = 1.0
    expect(body.operationalProgress).toBeCloseTo(1.0)

    // Os dois valores são diferentes — diferenciação explícita
    expect(body.acceptedAdvancement).not.toBe(body.operationalProgress)
  })

  it("retorna data_quality com cobertura e warnings", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")

    const dq = body.dataQuality as Record<string, unknown>
    expect(dq).toHaveProperty("weightCoverage")
    expect(dq).toHaveProperty("deadlineCoverage")
    expect(dq).toHaveProperty("durationCoverage")
    expect(dq).toHaveProperty("gateCoverage")
    expect(dq).toHaveProperty("warnings")
    expect(Array.isArray(dq.warnings)).toBe(true)
  })

  it("retorna blockedItems = 1 (subtarefa blocked)", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")
    expect(body.blockedItems).toBe(1)
  })

  it("retorna totalBlockedTimeSeconds do banco", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")
    expect(body.totalBlockedTimeSeconds).toBe(1800)
  })

  it("gateSuccessRate = 2/3 (2 passed, 1 failed)", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")
    expect(body.gateSuccessRate).toBeCloseTo(2 / 3)
  })

  it("deployReliability = 1.0 (1 deploy com smoke ok)", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")
    expect(body.deployReliability).toBe(1.0)
  })

  it("filter é retornado com valores null quando não especificado", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")
    const filter = body.filter as Record<string, unknown>
    expect(filter.projectId).toBeNull()
    expect(filter.taskId).toBeNull()
    expect(filter.from).toBeNull()
    expect(filter.to).toBeNull()
  })

  it("aceita filtro por projectId", async () => {
    const { status, body } = await makeRequest(api, "/api/motor/metrics?projectId=640")

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const filter = body.filter as Record<string, unknown>
    expect(filter.projectId).toBe(640)
  })

  it("aceita filtro por taskId", async () => {
    const { status, body } = await makeRequest(api, "/api/motor/metrics?taskId=100")

    expect(status).toBe(200)
    const filter = body.filter as Record<string, unknown>
    expect(filter.taskId).toBe(100)
  })

  it("aceita filtro por período (from/to)", async () => {
    const from = "2026-09-01T00:00:00Z"
    const to = "2026-09-30T23:59:59Z"
    const { status, body } = await makeRequest(api, `/api/motor/metrics?from=${from}&to=${to}`)

    expect(status).toBe(200)
    const filter = body.filter as Record<string, unknown>
    // Compara como Date para não depender do formato exato do toISOString()
    expect(new Date(filter.from as string).getTime()).toBe(new Date(from).getTime())
    expect(new Date(filter.to as string).getTime()).toBe(new Date(to).getTime())
  })

  it("retorna 503 quando DB não está disponível", async () => {
    const apiNoDb = new MotorAPI({
      port: 0,
      coordinator: createMockCoordinator(),
      // sem db
    })
    await apiNoDb.start()

    try {
      const { status, body } = await makeRequest(apiNoDb, "/api/motor/metrics")
      expect(status).toBe(503)
      expect(body.ok).toBe(false)
    } finally {
      await apiNoDb.stop()
    }
  })
})

// ============================================================================
// TESTES: GET /api/motor/metrics com dados vazios
// ============================================================================

describe("GET /api/motor/metrics — dados vazios", () => {
  let api: MotorAPI

  beforeEach(async () => {
    const db = createMockDb(() => ({
      rows: [],
      affectedRows: 0,
      insertId: 0,
    } satisfies QueryResult))

    api = new MotorAPI({
      port: 0,
      coordinator: createMockCoordinator(),
      db,
    })
    await api.start()
  })

  afterEach(async () => {
    await api.stop()
  })

  it("retorna null para KPIs quando não há dados", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")

    expect(body.ok).toBe(true)
    expect(body.acceptedAdvancement).toBeNull()
    expect(body.operationalProgress).toBeNull()
    expect(body.firstAttemptApprovalRate).toBeNull()
    expect(body.reworkRate).toBeNull()
    expect(body.blockerRate).toBeNull()
    expect(body.medianLeadTimeSeconds).toBeNull()
    expect(body.gateSuccessRate).toBeNull()
    expect(body.deployReliability).toBeNull()
  })

  it("data_quality contém aviso de dados insuficientes", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")

    const dq = body.dataQuality as Record<string, unknown>
    const warnings = dq.warnings as string[]
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((w: string) => w.includes("Nenhuma subtarefa"))).toBe(true)
  })

  it("totalWeightedScope = 0 quando não há dados", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")
    expect(body.totalWeightedScope).toBe(0)
  })
})

// ============================================================================
// TESTES: GET /api/motor/metrics/tasks
// ============================================================================

describe("GET /api/motor/metrics/tasks", () => {
  let api: MotorAPI

  beforeEach(async () => {
    const db = createMockDb((sql: string) => {
      // Count query
      if (sql.includes("COUNT(*)") && !sql.includes("CASE")) {
        return {
          rows: [{ total: 2 }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      // Tasks query
      if (sql.includes("FROM tarefas t")) {
        return {
          rows: [
            {
              id: "1",
              title: "Tarefa 1",
              status: "running",
              projeto_id: 640,
              created_at: base,
              completed_at: null,
              total_subtasks: 5,
              verified_count: 3,
              running_count: 1,
              blocked_count: 1,
              pending_count: 0,
              total_weight: 20,
              accepted_weight: 13,
            },
            {
              id: "2",
              title: "Tarefa 2",
              status: "completed",
              projeto_id: 640,
              created_at: base,
              completed_at: new Date(base.getTime() + 86400_000),
              total_subtasks: 3,
              verified_count: 3,
              running_count: 0,
              blocked_count: 0,
              pending_count: 0,
              total_weight: 10,
              accepted_weight: 10,
            },
          ],
          affectedRows: 2,
          insertId: 0,
        } satisfies QueryResult
      }
      return { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult
    })

    api = new MotorAPI({
      port: 0,
      coordinator: createMockCoordinator(),
      db,
    })
    await api.start()
  })

  afterEach(async () => {
    await api.stop()
  })

  const base = new Date("2026-09-01T10:00:00Z")

  it("retorna lista de tarefas com paginação", async () => {
    const { status, body } = await makeRequest(api, "/api/motor/metrics/tasks")

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty("pagination")
    expect(body).toHaveProperty("tasks")

    const pagination = body.pagination as Record<string, unknown>
    expect(pagination.page).toBe(1)
    expect(pagination.pageSize).toBe(20)
    expect(pagination.total).toBe(2)
    expect(pagination.totalPages).toBe(1)

    const tasks = body.tasks as Array<Record<string, unknown>>
    expect(tasks).toHaveLength(2)
  })

  it("cada tarefa tem subtasks e advancement", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics/tasks")

    const tasks = body.tasks as Array<Record<string, unknown>>
    const task1 = tasks[0]!

    expect(task1).toHaveProperty("subtasks")
    expect(task1).toHaveProperty("advancement")

    const subtasks = task1.subtasks as Record<string, unknown>
    expect(subtasks.total).toBe(5)
    expect(subtasks.verified).toBe(3)
    expect(subtasks.running).toBe(1)
    expect(subtasks.blocked).toBe(1)

    const advancement = task1.advancement as Record<string, unknown>
    expect(advancement.totalWeight).toBe(20)
    expect(advancement.acceptedWeight).toBe(13)
    expect(advancement.acceptedAdvancement).toBeCloseTo(13 / 20)
    // operational: (3 verified + 1 running + 1 blocked) / 5 = 1.0
    expect(advancement.operationalProgress).toBeCloseTo(1.0)
  })

  it("tarefa 2 tem avanço 100%", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics/tasks")

    const tasks = body.tasks as Array<Record<string, unknown>>
    const task2 = tasks[1]!

    const advancement = task2.advancement as Record<string, unknown>
    expect(advancement.acceptedAdvancement).toBe(1.0)
  })

  it("suporta filtro por projectId", async () => {
    const { status, body } = await makeRequest(api, "/api/motor/metrics/tasks?projectId=640")
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })

  it("suporta paginação customizada", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics/tasks?page=1&pageSize=1")

    const pagination = body.pagination as Record<string, unknown>
    expect(pagination.page).toBe(1)
    expect(pagination.pageSize).toBe(1)
    // total vem do mock (2 tarefas), totalPages = ceil(2/1) = 2
    expect(pagination.total).toBe(2)
    expect(pagination.totalPages).toBe(2)

    // O mock retorna todas as linhas independente do LIMIT;
    // validamos que a paginação foi calculada corretamente.
    const tasks = body.tasks as Array<Record<string, unknown>>
    expect(tasks.length).toBeGreaterThanOrEqual(1)
  })

  it("retorna 503 quando DB não está disponível", async () => {
    const apiNoDb = new MotorAPI({
      port: 0,
      coordinator: createMockCoordinator(),
    })
    await apiNoDb.start()

    try {
      const { status, body } = await makeRequest(apiNoDb, "/api/motor/metrics/tasks")
      expect(status).toBe(503)
      expect(body.ok).toBe(false)
    } finally {
      await apiNoDb.stop()
    }
  })
})

// ============================================================================
// TESTES: Compatibilidade e normalização
// ============================================================================

describe("Compatibilidade de status legado nas métricas", () => {
  let api: MotorAPI

  beforeEach(async () => {
    const db = createMockDb((sql: string) => {
      if (sql.includes("FROM subtarefas s")) {
        return {
          rows: [
            {
              id: 1,
              status: "verified",
              weight: 5,
              planned_start: null,
              planned_end: null,
              created_at: base,
              verified_at: new Date(base.getTime() + 3600_000),
              superseded_by_subtask_id: null,
              verified_attempt: 1,
              attempt_count: 1,
              has_blocker: 0,
            },
          ],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      if (sql.includes("FROM execution_attempts ea")) {
        return {
          rows: [{
            id: 1,
            subtask_id: 1,
            attempt_number: 1,
            started_at: base,
            finished_at: new Date(base.getTime() + 3600_000),
            outcome: "verified",
            duration_ms: 3600_000,
            gate_count: 2,
          }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      if (sql.includes("FROM gate_runs gr")) {
        return {
          rows: [
            { id: 1, attempt_id: 1, gate_type: "build", status: "passed" },
            { id: 2, attempt_id: 1, gate_type: "test", status: "passed" },
          ],
          affectedRows: 2,
          insertId: 0,
        } satisfies QueryResult
      }
      if (sql.includes("FROM tarefas t") && sql.includes("deployed_at")) {
        return { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult
      }
      if (sql.includes("FROM bloqueios b")) {
        return {
          rows: [{ total_blocked_seconds: 0 }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      return { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult
    })

    api = new MotorAPI({
      port: 0,
      coordinator: createMockCoordinator(),
      db,
    })
    await api.start()
  })

  afterEach(async () => {
    await api.stop()
  })

  const base = new Date("2026-09-01T10:00:00Z")

  it("resposta é compatível com consumidores externos (JSON puro)", async () => {
    const { status, body } = await makeRequest(api, "/api/motor/metrics")

    expect(status).toBe(200)
    expect(body.ok).toBe(true)

    // Todos os campos são serializáveis (sem Date objects, BigInt, etc.)
    const serialized = JSON.stringify(body)
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    expect(parsed.ok).toBe(true)
    expect(typeof parsed.computedAt).toBe("string")
  })

  it("computedAt é string ISO-8601", async () => {
    const { body } = await makeRequest(api, "/api/motor/metrics")
    const computedAt = body.computedAt as string
    expect(computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})
