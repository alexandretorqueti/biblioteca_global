/**
 * Testes E2E de métricas — 4 cenários ponta a ponta.
 *
 * Cada cenário simula o ciclo completo de uma subtarefa usando mock DB
 * e verifica que os KPIs calculados refletem o comportamento esperado.
 *
 * Cenários:
 * 1. Sucesso na primeira tentativa
 * 2. Falha + retrabalho (2 tentativas)
 * 3. Bloqueio + retomada
 * 4. Deploy + smoke test reprovado
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from "vitest"
import {
  AdvancementMetricsRepository,
  computeAcceptedAdvancement,
  computeOperationalProgress,
  computeFirstAttemptApprovalRate,
  computeReworkRate,
  computeBlockerRate,
  computeMedianLeadTimeSeconds,
  computeGateSuccessRate,
  computeDeployReliability,
  computeDataQuality,
  type SubtaskMetricsRow,
  type GateMetricsRow,
  type DeployMetricsRow,
} from "../src/metrics/AdvancementMetrics.js"
import type { Db, QueryResult } from "../src/shared/types/infrastructure.js"

// ============================================================================
// MOCK DB FACTORY
// ============================================================================

interface MockQueryHandler {
  (sql: string, params?: unknown[]): QueryResult
}

function createScenarioDb(handler: MockQueryHandler): Db {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => handler(sql, params ?? [])),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn({} as Db)),
  }
}

// ============================================================================
// CENÁRIO 1: Sucesso na primeira tentativa
// ============================================================================

describe("E2E: Sucesso na primeira tentativa", () => {
  const base = new Date("2026-09-01T10:00:00Z")
  const verifiedAt = new Date(base.getTime() + 1000 * 3600) // 1h depois

  const subtasks: SubtaskMetricsRow[] = [
    {
      id: 10,
      status: "verified",
      weight: 5,
      planned_start: base,
      planned_end: new Date(base.getTime() + 1000 * 7200),
      created_at: base,
      verified_at: verifiedAt,
      superseded_by_subtask_id: null,
      verified_attempt: 1,
      attempt_count: 1,
      has_blocker: false,
    },
  ]

  it("avanço aceito = 100%", () => {
    const result = computeAcceptedAdvancement(subtasks)
    expect(result.value).toBe(1.0)
    expect(result.totalWeight).toBe(5)
    expect(result.acceptedWeight).toBe(5)
  })

  it("primeira aprovação = 100%", () => {
    const result = computeFirstAttemptApprovalRate(subtasks)
    expect(result.value).toBe(1.0)
  })

  it("retrabalho = 0%", () => {
    const result = computeReworkRate(subtasks)
    expect(result.value).toBe(0)
  })

  it("bloqueio = 0%", () => {
    const result = computeBlockerRate(subtasks)
    expect(result.value).toBe(0)
  })

  it("lead time = 3600s (1h)", () => {
    const result = computeMedianLeadTimeSeconds(subtasks)
    expect(result.value).toBe(3600)
  })

  it("gates com 100% de sucesso", () => {
    const gates: GateMetricsRow[] = [
      { id: 1, attempt_id: 1, gate_type: "build", status: "passed" },
      { id: 2, attempt_id: 1, gate_type: "test", status: "passed" },
      { id: 3, attempt_id: 1, gate_type: "lint", status: "passed" },
    ]
    const result = computeGateSuccessRate(gates)
    expect(result.value).toBe(1.0)
  })

  it("dados de qualidade: cobertura total com pesos e prazos", () => {
    const quality = computeDataQuality(subtasks, [], [])
    expect(quality.weightCoverage).toBe(1.0)
    expect(quality.deadlineCoverage).toBe(1.0)
    expect(quality.warnings).toHaveLength(0)
  })
})

// ============================================================================
// CENÁRIO 2: Falha + retrabalho (2 tentativas)
// ============================================================================

describe("E2E: Falha + retrabalho", () => {
  const base = new Date("2026-09-01T10:00:00Z")
  const verifiedAt = new Date(base.getTime() + 1000 * 7200) // 2h depois

  const subtasks: SubtaskMetricsRow[] = [
    {
      id: 20,
      status: "verified",
      weight: 8,
      planned_start: base,
      planned_end: new Date(base.getTime() + 1000 * 10800),
      created_at: base,
      verified_at: verifiedAt,
      superseded_by_subtask_id: null,
      verified_attempt: 2, // verificada na tentativa 2
      attempt_count: 2,    // 2 tentativas
      has_blocker: false,
    },
  ]

  it("avanço aceito = 100% (após retrabalho)", () => {
    const result = computeAcceptedAdvancement(subtasks)
    expect(result.value).toBe(1.0)
  })

  it("primeira aprovação = 0% (verificou na tentativa 2)", () => {
    const result = computeFirstAttemptApprovalRate(subtasks)
    expect(result.value).toBe(0)
  })

  it("retrabalho = 100% (2 tentativas)", () => {
    const result = computeReworkRate(subtasks)
    expect(result.value).toBe(1.0)
    expect(result.reworkCount).toBe(1)
  })

  it("lead time = 7200s (2h)", () => {
    const result = computeMedianLeadTimeSeconds(subtasks)
    expect(result.value).toBe(7200)
  })

  it("gates: tentativa 1 falhou, tentativa 2 passou", () => {
    const gates: GateMetricsRow[] = [
      { id: 1, attempt_id: 1, gate_type: "build", status: "passed" },
      { id: 2, attempt_id: 1, gate_type: "test", status: "failed" },
      { id: 3, attempt_id: 2, gate_type: "build", status: "passed" },
      { id: 4, attempt_id: 2, gate_type: "test", status: "passed" },
    ]
    const result = computeGateSuccessRate(gates)
    expect(result.value).toBeCloseTo(3 / 4) // 3/4 = 75%
  })
})

// ============================================================================
// CENÁRIO 3: Bloqueio + retomada
// ============================================================================

describe("E2E: Bloqueio + retomada", () => {
  const base = new Date("2026-09-01T10:00:00Z")
  const verifiedAt = new Date(base.getTime() + 1000 * 14400) // 4h depois

  const subtasks: SubtaskMetricsRow[] = [
    {
      id: 30,
      status: "verified",
      weight: 3,
      planned_start: base,
      planned_end: new Date(base.getTime() + 1000 * 7200),
      created_at: base,
      verified_at: verifiedAt,
      superseded_by_subtask_id: null,
      verified_attempt: 1,
      attempt_count: 1,
      has_blocker: true, // teve bloqueio
    },
    {
      id: 31,
      status: "running",
      weight: 5,
      planned_start: base,
      planned_end: new Date(base.getTime() + 1000 * 10800),
      created_at: base,
      verified_at: null,
      superseded_by_subtask_id: null,
      verified_attempt: null,
      attempt_count: 1,
      has_blocker: true, // ainda bloqueada
    },
  ]

  it("avanço aceito parcial (1 de 2 verified)", () => {
    const result = computeAcceptedAdvancement(subtasks)
    // 3 / (3 + 5) = 0.375
    expect(result.value).toBeCloseTo(3 / 8)
  })

  it("bloqueio = 100% (ambas têm bloqueio)", () => {
    const result = computeBlockerRate(subtasks)
    expect(result.value).toBe(1.0)
    expect(result.blockedCount).toBe(2)
  })

  it("primeira aprovação = 100% (a verified foi na tentativa 1)", () => {
    const result = computeFirstAttemptApprovalRate(subtasks)
    expect(result.value).toBe(1.0)
  })

  it("lead time considera apenas a verified", () => {
    const result = computeMedianLeadTimeSeconds(subtasks)
    expect(result.value).toBe(14400) // 4h
    expect(result.count).toBe(1)
  })
})

// ============================================================================
// CENÁRIO 4: Deploy + smoke test reprovado
// ============================================================================

describe("E2E: Deploy + smoke test reprovado", () => {
  it("deploy com smoke reprovado NÃO é confiável", () => {
    const deploys: DeployMetricsRow[] = [
      { id: "100", deployed_at: new Date("2026-09-01T12:00:00Z"), smoke_test_ok: false },
    ]
    const result = computeDeployReliability(deploys)
    expect(result.value).toBe(0)
    expect(result.totalCount).toBe(1)
    expect(result.reliableCount).toBe(0)
  })

  it("deploy sem smoke test (NULL) NÃO é confiável", () => {
    const deploys: DeployMetricsRow[] = [
      { id: "100", deployed_at: new Date("2026-09-01T12:00:00Z"), smoke_test_ok: null },
    ]
    const result = computeDeployReliability(deploys)
    expect(result.value).toBe(0)
  })

  it("mixture: 1 confiável, 1 não, 1 sem smoke = 1/3", () => {
    const deploys: DeployMetricsRow[] = [
      { id: "1", deployed_at: new Date(), smoke_test_ok: true },
      { id: "2", deployed_at: new Date(), smoke_test_ok: false },
      { id: "3", deployed_at: new Date(), smoke_test_ok: null },
    ]
    const result = computeDeployReliability(deploys)
    expect(result.value).toBeCloseTo(1 / 3)
  })

  it("cenário completo: subtarefas verified + deploy não confiável", () => {
    const base = new Date("2026-09-01T10:00:00Z")

    const subtasks: SubtaskMetricsRow[] = [
      {
        id: 40,
        status: "verified",
        weight: 5,
        planned_start: base,
        planned_end: new Date(base.getTime() + 1000 * 3600),
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 3000),
        superseded_by_subtask_id: null,
        verified_attempt: 1,
        attempt_count: 1,
        has_blocker: false,
      },
    ]

    const deploys: DeployMetricsRow[] = [
      { id: "40", deployed_at: new Date(base.getTime() + 1000 * 4000), smoke_test_ok: false },
    ]

    // Avanço aceito = 100% (subtarefa verified)
    const advancement = computeAcceptedAdvancement(subtasks)
    expect(advancement.value).toBe(1.0)

    // Confiabilidade pós-deploy = 0% (smoke reprovado)
    const reliability = computeDeployReliability(deploys)
    expect(reliability.value).toBe(0)

    // Os dois KPIs são independentes: avanço técnico ok, mas deploy não confiável
  })
})

// ============================================================================
// CENÁRIO COMBINADO: Múltiplas subtarefas com qualidade de dados
// ============================================================================

describe("E2E: Cenário combinado com data quality", () => {
  const base = new Date("2026-09-01T10:00:00Z")

  function makeSubtask(overrides: Partial<SubtaskMetricsRow>): SubtaskMetricsRow {
    return {
      status: "pending",
      weight: null,
      planned_start: null,
      planned_end: null,
      created_at: base,
      verified_at: null,
      superseded_by_subtask_id: null,
      verified_attempt: null,
      attempt_count: 0,
      has_blocker: false,
      ...overrides,
    }
  }

  const subtasks: SubtaskMetricsRow[] = [
    // 1: sucesso na primeira
    makeSubtask({ id: 1, status: "verified", weight: 5, verified_attempt: 1, attempt_count: 1, created_at: base, verified_at: new Date(base.getTime() + 3600_000) }),
    // 2: retrabalho
    makeSubtask({ id: 2, status: "verified", weight: 3, verified_attempt: 2, attempt_count: 2, created_at: base, verified_at: new Date(base.getTime() + 7200_000) }),
    // 3: em execução
    makeSubtask({ id: 3, status: "running", weight: 8, attempt_count: 1, created_at: base }),
    // 4: bloqueada
    makeSubtask({ id: 4, status: "blocked", weight: 2, attempt_count: 1, has_blocker: true, created_at: base }),
    // 5: pending (não iniciada)
    makeSubtask({ id: 5, status: "pending", weight: 5, created_at: base }),
    // 6: skipped (excluída)
    makeSubtask({ id: 6, status: "skipped", weight: 1, created_at: base }),
  ]

  it("avanço aceito ponderado considera apenas verified/completed", () => {
    const result = computeAcceptedAdvancement(subtasks)
    // Elegíveis: 1,2,3,4,5 (6 é skipped) = 5+3+8+2+5 = 23
    // Aceitos: 1(5) + 2(3) = 8
    // 8/23 ≈ 0.3478
    expect(result.value).toBeCloseTo(8 / 23)
    expect(result.totalWeight).toBe(23)
  })

  it("progresso operacional inclui running e blocked", () => {
    const result = computeOperationalProgress(subtasks)
    // verified(1) + verified(2) + running(3) + blocked(4) = 4 de 5 elegíveis
    // pending não conta como operational
    expect(result.value).toBeCloseTo(4 / 5)
  })

  it("primeira aprovação = 50% (1 de 2 verified na tentativa 1)", () => {
    const result = computeFirstAttemptApprovalRate(subtasks)
    expect(result.value).toBeCloseTo(0.5)
  })

  it("retrabalho = 25% (1 de 4 iniciadas com >1 tentativa)", () => {
    const result = computeReworkRate(subtasks)
    // 4 iniciadas, 1 com >1 tentativa → 1/4 = 0.25
    expect(result.value).toBeCloseTo(1 / 4)
  })

  it("bloqueio = 25% (1 de 4 iniciadas)", () => {
    const result = computeBlockerRate(subtasks)
    expect(result.value).toBeCloseTo(1 / 4)
  })

  it("data quality: cobertura de pesos = 100%", () => {
    const quality = computeDataQuality(subtasks, [], [])
    // Todas as elegíveis têm peso definido
    expect(quality.weightCoverage).toBe(1.0)
  })
})

// ============================================================================
// REPOSITÓRIO: Teste de integração com mock DB
// ============================================================================

describe("E2E: AdvancementMetricsRepository com mock DB", () => {
  it("compute() retorna resultado estruturado com todos os KPIs", async () => {
    const base = new Date("2026-09-01T10:00:00Z")

    const db = createScenarioDb((sql: string) => {
      // fetchSubtasks
      if (sql.includes("FROM subtarefas s")) {
        return {
          rows: [{
            id: 10,
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
          }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      // fetchAttempts
      if (sql.includes("FROM execution_attempts ea")) {
        return {
          rows: [{
            id: 1,
            subtask_id: 10,
            attempt_number: 1,
            started_at: base,
            finished_at: new Date(base.getTime() + 3600_000),
            outcome: "verified",
            duration_ms: 3600_000,
            gate_count: 3,
          }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      // fetchGates
      if (sql.includes("FROM gate_runs gr")) {
        return {
          rows: [
            { id: 1, attempt_id: 1, gate_type: "build", status: "passed" },
            { id: 2, attempt_id: 1, gate_type: "test", status: "passed" },
            { id: 3, attempt_id: 1, gate_type: "lint", status: "passed" },
          ],
          affectedRows: 3,
          insertId: 0,
        } satisfies QueryResult
      }
      // fetchDeploys
      if (sql.includes("FROM tarefas t") && sql.includes("deployed_at")) {
        return {
          rows: [{ id: "10", deployed_at: new Date(base.getTime() + 4000_000), smoke_test_ok: true }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      // fetchBlockedTimeSeconds
      if (sql.includes("FROM bloqueios b")) {
        return {
          rows: [{ total_blocked_seconds: 0 }],
          affectedRows: 1,
          insertId: 0,
        } satisfies QueryResult
      }
      return { rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult
    })

    const repo = new AdvancementMetricsRepository(db)
    const result = await repo.compute({ projectId: 640 })

    expect(result.acceptedAdvancement).toBe(1.0)
    expect(result.firstAttemptApprovalRate).toBe(1.0)
    expect(result.reworkRate).toBe(0)
    expect(result.blockerRate).toBe(0)
    expect(result.medianLeadTimeSeconds).toBe(3600)
    expect(result.totalBlockedTimeSeconds).toBe(0)
    expect(result.gateSuccessRate).toBe(1.0)
    expect(result.deployReliability).toBe(1.0)
    expect(result.totalWeightedScope).toBe(5)
    expect(result.dataQuality.weightCoverage).toBe(1.0)
    expect(result.filter.projectId).toBe(640)
    expect(result.computedAt).toBeInstanceOf(Date)
  })

  it("compute() com dados vazios retorna avisos e nulls", async () => {
    const db = createScenarioDb(() => ({
      rows: [],
      affectedRows: 0,
      insertId: 0,
    } satisfies QueryResult))

    const repo = new AdvancementMetricsRepository(db)
    const result = await repo.compute()

    expect(result.acceptedAdvancement).toBeNull()
    expect(result.operationalProgress).toBeNull()
    expect(result.firstAttemptApprovalRate).toBeNull()
    expect(result.reworkRate).toBeNull()
    expect(result.blockerRate).toBeNull()
    expect(result.medianLeadTimeSeconds).toBeNull()
    expect(result.gateSuccessRate).toBeNull()
    expect(result.deployReliability).toBeNull()
    expect(result.dataQuality.warnings).toContain("Nenhuma subtarefa elegível encontrada para o filtro.")
  })
})
