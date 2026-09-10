/**
 * Testes unitários para cálculo de KPIs de avanço.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest"
import {
  computeAcceptedAdvancement,
  computeOperationalProgress,
  computeFirstAttemptApprovalRate,
  computeReworkRate,
  computeBlockerRate,
  computeMedianLeadTimeSeconds,
  computeMedian,
  computeGateSuccessRate,
  computeDeployReliability,
  computeDataQuality,
  type SubtaskMetricsRow,
  type AttemptMetricsRow,
  type GateMetricsRow,
  type DeployMetricsRow,
} from "../src/metrics/AdvancementMetrics.js"

// ============================================================================
// HELPERS
// ============================================================================

function makeSubtask(overrides: Partial<SubtaskMetricsRow> = {}): SubtaskMetricsRow {
  return {
    id: overrides.id ?? 1,
    status: overrides.status ?? "pending",
    weight: overrides.weight ?? null,
    planned_start: overrides.planned_start ?? null,
    planned_end: overrides.planned_end ?? null,
    created_at: overrides.created_at ?? new Date("2026-09-01T10:00:00Z"),
    verified_at: overrides.verified_at ?? null,
    superseded_by_subtask_id: overrides.superseded_by_subtask_id ?? null,
    verified_attempt: overrides.verified_attempt ?? null,
    attempt_count: overrides.attempt_count ?? 0,
    has_blocker: overrides.has_blocker ?? false,
  }
}

// ============================================================================
// computeAcceptedAdvancement
// ============================================================================

describe("computeAcceptedAdvancement", () => {
  it("retorna null quando não há subtarefas elegíveis", () => {
    const result = computeAcceptedAdvancement([])
    expect(result.value).toBeNull()
    expect(result.totalWeight).toBe(0)
  })

  it("retorna null quando todas as subtarefas são skipped", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "skipped" }),
      makeSubtask({ id: 2, status: "skipped" }),
    ]
    const result = computeAcceptedAdvancement(subtasks)
    expect(result.value).toBeNull()
  })

  it("calcula avanço aceito com pesos default (1)", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", weight: null }),
      makeSubtask({ id: 2, status: "running", weight: null }),
      makeSubtask({ id: 3, status: "pending", weight: null }),
    ]
    const result = computeAcceptedAdvancement(subtasks)
    // 1 accepted / 3 eligible = 0.333...
    expect(result.value).toBeCloseTo(1 / 3)
    expect(result.totalWeight).toBe(3)
    expect(result.acceptedWeight).toBe(1)
  })

  it("calcula avanço aceito ponderado com pesos customizados", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", weight: 5 }),
      makeSubtask({ id: 2, status: "verified", weight: 3 }),
      makeSubtask({ id: 3, status: "running", weight: 8 }),
      makeSubtask({ id: 4, status: "pending", weight: 2 }),
    ]
    const result = computeAcceptedAdvancement(subtasks)
    // (5 + 3) / (5 + 3 + 8 + 2) = 8/18
    expect(result.value).toBeCloseTo(8 / 18)
    expect(result.totalWeight).toBe(18)
    expect(result.acceptedWeight).toBe(8)
  })

  it("exclui superseded COM sucessora do denominador", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", weight: 5 }),
      makeSubtask({ id: 2, status: "superseded", weight: 3, superseded_by_subtask_id: 3 }),
      makeSubtask({ id: 3, status: "verified", weight: 3 }),
    ]
    const result = computeAcceptedAdvancement(subtasks)
    // superseded com sucessora é excluído: (5 + 3) / (5 + 3) = 1.0
    expect(result.value).toBeCloseTo(1.0)
    expect(result.totalWeight).toBe(8)
  })

  it("mantém superseded SEM sucessora no denominador", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", weight: 5 }),
      makeSubtask({ id: 2, status: "superseded", weight: 3, superseded_by_subtask_id: null }),
    ]
    const result = computeAcceptedAdvancement(subtasks)
    // superseded sem sucessora conta: 5 / (5 + 3) = 0.625
    expect(result.value).toBeCloseTo(0.625)
  })

  it("completed conta como aceito", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "completed", weight: 5 }),
      makeSubtask({ id: 2, status: "pending", weight: 5 }),
    ]
    const result = computeAcceptedAdvancement(subtasks)
    expect(result.value).toBeCloseTo(0.5)
  })

  it("rejected NÃO conta como aceito", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "rejected", weight: 5 }),
      makeSubtask({ id: 2, status: "verified", weight: 5 }),
    ]
    const result = computeAcceptedAdvancement(subtasks)
    // rejected é operational, não accepted: 5 / 10 = 0.5
    expect(result.value).toBeCloseTo(0.5)
  })
})

// ============================================================================
// computeOperationalProgress
// ============================================================================

describe("computeOperationalProgress", () => {
  it("retorna null quando não há subtarefas elegíveis", () => {
    const result = computeOperationalProgress([])
    expect(result.value).toBeNull()
  })

  it("calcula progresso incluindo operational e accepted", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified" }),
      makeSubtask({ id: 2, status: "running" }),
      makeSubtask({ id: 3, status: "pending" }),
      makeSubtask({ id: 4, status: "blocked" }),
    ]
    const result = computeOperationalProgress(subtasks)
    // verified + running + blocked = 3 operational/accepted de 4 elegíveis
    // pending é not_started, não conta como operational
    expect(result.value).toBeCloseTo(3 / 4)
    expect(result.operationalCount).toBe(3)
  })

  it("exclui skipped do denominador", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "running" }),
      makeSubtask({ id: 2, status: "skipped" }),
    ]
    const result = computeOperationalProgress(subtasks)
    expect(result.value).toBeCloseTo(1.0)
    expect(result.total).toBe(1)
  })
})

// ============================================================================
// computeFirstAttemptApprovalRate
// ============================================================================

describe("computeFirstAttemptApprovalRate", () => {
  it("retorna null quando não há subtarefas verified", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "running" }),
      makeSubtask({ id: 2, status: "pending" }),
    ]
    const result = computeFirstAttemptApprovalRate(subtasks)
    expect(result.value).toBeNull()
  })

  it("calcula taxa de primeira aprovação", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", verified_attempt: 1 }),
      makeSubtask({ id: 2, status: "verified", verified_attempt: 2 }),
      makeSubtask({ id: 3, status: "verified", verified_attempt: 1 }),
    ]
    const result = computeFirstAttemptApprovalRate(subtasks)
    expect(result.value).toBeCloseTo(2 / 3)
    expect(result.firstAttemptCount).toBe(2)
    expect(result.verifiedCount).toBe(3)
  })

  it("completed conta como verified para primeira aprovação", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "completed", verified_attempt: 1 }),
    ]
    const result = computeFirstAttemptApprovalRate(subtasks)
    expect(result.value).toBeCloseTo(1.0)
  })
})

// ============================================================================
// computeReworkRate
// ============================================================================

describe("computeReworkRate", () => {
  it("retorna null quando não há subtarefas iniciadas", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "pending", attempt_count: 0 }),
    ]
    const result = computeReworkRate(subtasks)
    expect(result.value).toBeNull()
  })

  it("calcula taxa de retrabalho", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", attempt_count: 1 }),
      makeSubtask({ id: 2, status: "verified", attempt_count: 3 }),
      makeSubtask({ id: 3, status: "running", attempt_count: 2 }),
      makeSubtask({ id: 4, status: "pending", attempt_count: 0 }),
    ]
    const result = computeReworkRate(subtasks)
    // 3 iniciadas (attempt_count > 0), 2 com >1 tentativa
    expect(result.value).toBeCloseTo(2 / 3)
    expect(result.reworkCount).toBe(2)
    expect(result.startedCount).toBe(3)
  })
})

// ============================================================================
// computeBlockerRate
// ============================================================================

describe("computeBlockerRate", () => {
  it("retorna null quando não há subtarefas iniciadas", () => {
    const result = computeBlockerRate([])
    expect(result.value).toBeNull()
  })

  it("calcula taxa de bloqueio", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", attempt_count: 1, has_blocker: false }),
      makeSubtask({ id: 2, status: "running", attempt_count: 1, has_blocker: true }),
      makeSubtask({ id: 3, status: "verified", attempt_count: 2, has_blocker: true }),
    ]
    const result = computeBlockerRate(subtasks)
    expect(result.value).toBeCloseTo(2 / 3)
    expect(result.blockedCount).toBe(2)
  })
})

// ============================================================================
// computeMedianLeadTimeSeconds
// ============================================================================

describe("computeMedianLeadTimeSeconds", () => {
  it("retorna null quando não há subtarefas verified com verified_at", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "running" }),
    ]
    const result = computeMedianLeadTimeSeconds(subtasks)
    expect(result.value).toBeNull()
  })

  it("calcula lead time mediano", () => {
    const base = new Date("2026-09-01T10:00:00Z")
    const subtasks = [
      makeSubtask({
        id: 1,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 3600), // 1h
      }),
      makeSubtask({
        id: 2,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 7200), // 2h
      }),
      makeSubtask({
        id: 3,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 10800), // 3h
      }),
    ]
    const result = computeMedianLeadTimeSeconds(subtasks)
    // Mediana de [3600, 7200, 10800] = 7200
    expect(result.value).toBe(7200)
    expect(result.count).toBe(3)
  })

  it("calcula mediana com número par", () => {
    const base = new Date("2026-09-01T10:00:00Z")
    const subtasks = [
      makeSubtask({
        id: 1,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 1000),
      }),
      makeSubtask({
        id: 2,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 2000),
      }),
      makeSubtask({
        id: 3,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 3000),
      }),
      makeSubtask({
        id: 4,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 4000),
      }),
    ]
    const result = computeMedianLeadTimeSeconds(subtasks)
    // Mediana de [1000, 2000, 3000, 4000] = (2000 + 3000) / 2 = 2500
    expect(result.value).toBe(2500)
  })

  it("ignora lead times negativos (verified_at antes de created_at)", () => {
    const base = new Date("2026-09-01T10:00:00Z")
    const subtasks = [
      makeSubtask({
        id: 1,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() - 1000 * 1000), // negativo
      }),
      makeSubtask({
        id: 2,
        status: "verified",
        created_at: base,
        verified_at: new Date(base.getTime() + 1000 * 5000),
      }),
    ]
    const result = computeMedianLeadTimeSeconds(subtasks)
    expect(result.value).toBe(5000)
    expect(result.count).toBe(1)
  })
})

// ============================================================================
// computeMedian
// ============================================================================

describe("computeMedian", () => {
  it("retorna 0 para array vazio", () => {
    expect(computeMedian([])).toBe(0)
  })

  it("retorna o único elemento para array de 1", () => {
    expect(computeMedian([42])).toBe(42)
  })

  it("retorna o elemento do meio para array ímpar", () => {
    expect(computeMedian([1, 2, 3])).toBe(2)
  })

  it("retorna a média dos dois do meio para array par", () => {
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5)
  })
})

// ============================================================================
// computeGateSuccessRate
// ============================================================================

describe("computeGateSuccessRate", () => {
  it("retorna null quando não há gates", () => {
    const result = computeGateSuccessRate([])
    expect(result.value).toBeNull()
  })

  it("calcula taxa de sucesso de gates", () => {
    const gates: GateMetricsRow[] = [
      { id: 1, attempt_id: 1, gate_type: "build", status: "passed" },
      { id: 2, attempt_id: 1, gate_type: "test", status: "passed" },
      { id: 3, attempt_id: 1, gate_type: "lint", status: "failed" },
      { id: 4, attempt_id: 2, gate_type: "build", status: "passed" },
    ]
    const result = computeGateSuccessRate(gates)
    expect(result.value).toBeCloseTo(3 / 4)
    expect(result.passedCount).toBe(3)
    expect(result.totalCount).toBe(4)
  })
})

// ============================================================================
// computeDeployReliability
// ============================================================================

describe("computeDeployReliability", () => {
  it("retorna null quando não há deploys", () => {
    const result = computeDeployReliability([])
    expect(result.value).toBeNull()
  })

  it("retorna null quando deploys não têm deployed_at", () => {
    const deploys: DeployMetricsRow[] = [
      { id: "1", deployed_at: null, smoke_test_ok: null },
    ]
    const result = computeDeployReliability(deploys)
    expect(result.value).toBeNull()
  })

  it("calcula confiabilidade pós-deploy", () => {
    const deploys: DeployMetricsRow[] = [
      { id: "1", deployed_at: new Date(), smoke_test_ok: true },
      { id: "2", deployed_at: new Date(), smoke_test_ok: true },
      { id: "3", deployed_at: new Date(), smoke_test_ok: false },
      { id: "4", deployed_at: new Date(), smoke_test_ok: null }, // não verificado
    ]
    const result = computeDeployReliability(deploys)
    // 2 confiáveis / 4 deploys = 0.5
    expect(result.value).toBeCloseTo(0.5)
    expect(result.reliableCount).toBe(2)
    expect(result.totalCount).toBe(4)
  })

  it("deploy sem smoke_test_ok NÃO conta como confiável", () => {
    const deploys: DeployMetricsRow[] = [
      { id: "1", deployed_at: new Date(), smoke_test_ok: null },
    ]
    const result = computeDeployReliability(deploys)
    expect(result.value).toBe(0)
    expect(result.reliableCount).toBe(0)
    expect(result.totalCount).toBe(1)
  })
})

// ============================================================================
// computeDataQuality
// ============================================================================

describe("computeDataQuality", () => {
  it("retorna avisos quando não há subtarefas", () => {
    const quality = computeDataQuality([], [], [])
    expect(quality.warnings).toContain("Nenhuma subtarefa elegível encontrada para o filtro.")
    expect(quality.weightCoverage).toBe(0)
  })

  it("calcula cobertura de pesos", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", weight: 5 }),
      makeSubtask({ id: 2, status: "running", weight: null }),
      makeSubtask({ id: 3, status: "pending", weight: 3 }),
      makeSubtask({ id: 4, status: "verified", weight: null }),
    ]
    const quality = computeDataQuality(subtasks, [], [])
    // 2 com peso / 4 elegíveis = 0.5
    expect(quality.weightCoverage).toBeCloseTo(0.5)
  })

  it("calcula cobertura de prazos", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", planned_start: new Date(), planned_end: new Date() }),
      makeSubtask({ id: 2, status: "running", planned_start: null, planned_end: null }),
    ]
    const quality = computeDataQuality(subtasks, [], [])
    expect(quality.deadlineCoverage).toBeCloseTo(0.5)
  })

  it("calcula cobertura de duração das tentativas", () => {
    const attempts: AttemptMetricsRow[] = [
      { id: 1, subtask_id: 1, attempt_number: 1, started_at: new Date(), finished_at: new Date(), outcome: "verified", duration_ms: 5000, gate_count: 2 },
      { id: 2, subtask_id: 2, attempt_number: 1, started_at: new Date(), finished_at: null, outcome: "running", duration_ms: null, gate_count: 0 },
    ]
    const quality = computeDataQuality([], attempts, [])
    expect(quality.durationCoverage).toBeCloseTo(0.5)
  })

  it("calcula cobertura de gates", () => {
    const attempts: AttemptMetricsRow[] = [
      { id: 1, subtask_id: 1, attempt_number: 1, started_at: new Date(), finished_at: new Date(), outcome: "verified", duration_ms: 5000, gate_count: 3 },
      { id: 2, subtask_id: 2, attempt_number: 1, started_at: new Date(), finished_at: new Date(), outcome: "verified", duration_ms: 3000, gate_count: 0 },
    ]
    const quality = computeDataQuality([], attempts, [])
    expect(quality.gateCoverage).toBeCloseTo(0.5)
  })

  it("gera aviso quando cobertura de pesos é baixa", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "verified", weight: null }),
      makeSubtask({ id: 2, status: "running", weight: null }),
      makeSubtask({ id: 3, status: "pending", weight: null }),
      makeSubtask({ id: 4, status: "verified", weight: 5 }),
    ]
    const quality = computeDataQuality(subtasks, [], [])
    // 1/4 = 0.25 < 0.5
    expect(quality.warnings.some((w) => w.includes("Cobertura de pesos baixa"))).toBe(true)
  })

  it("exclui skipped da contagem de cobertura", () => {
    const subtasks = [
      makeSubtask({ id: 1, status: "skipped", weight: null }),
      makeSubtask({ id: 2, status: "verified", weight: 5 }),
    ]
    const quality = computeDataQuality(subtasks, [], [])
    // skipped é excluído; 1 elegível com peso = 1.0
    expect(quality.weightCoverage).toBe(1.0)
  })
})
