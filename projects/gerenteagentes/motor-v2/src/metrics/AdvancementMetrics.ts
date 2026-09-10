/**
 * AdvancementMetrics — Cálculo reproduzível de KPIs de avanço do Motor.
 *
 * Regras de negócio:
 * - Avanço aceito ponderado: Σ(peso × 1 para verified) / Σ(pesos elegíveis)
 * - Progresso operacional: subtarefas em execução / elegíveis (não é aceite)
 * - Primeira aprovação: verified na tentativa 1 / total verified
 * - Retrabalho: subtarefas com >1 tentativa / subtarefas iniciadas
 * - Bloqueio: subtarefas com bloqueio / subtarefas iniciadas
 * - Lead time: mediana(verified_at - created_at) das subtarefas verified
 * - Tempo bloqueado: soma dos intervalos blocked_at → resolved_at
 * - Sucesso de gates: gates passed / gates executados
 * - Confiabilidade pós-deploy: deploys com smoke aprovado / deploys realizados
 *
 * Qualidade de dados:
 * - Se denominador = 0 ou dados mínimos ausentes, retorna aviso em vez de percentual.
 * - data_quality informa cobertura de pesos, prazos, duração e gates.
 */

import type { Db, QueryResult } from "../shared/types/infrastructure.js"
import { computeSubtaskDenominator, type SubtaskDenominatorRow } from "../shared/status-normalization.js"
import { SUBTASK_STATUS_CATEGORIES, type SubTaskStatusValue } from "../shared/task-statuses.js"

// ============================================================================
// TYPES
// ============================================================================

export interface MetricsFilter {
  projectId?: number
  taskId?: number
  from?: Date
  to?: Date
}

export interface DataQuality {
  /** Percentual de subtarefas elegíveis com peso definido (0-1). */
  weightCoverage: number
  /** Percentual de subtarefas elegíveis com prazo planejado (0-1). */
  deadlineCoverage: number
  /** Percentual de tentativas com duração preenchida (0-1). */
  durationCoverage: number
  /** Percentual de tentativas com pelo menos 1 gate registrado (0-1). */
  gateCoverage: number
  /** Avisos sobre dados insuficientes para algum KPI. */
  warnings: string[]
}

export interface AdvancementMetricsResult {
  /** Escopo total ponderado (soma dos pesos elegíveis). */
  totalWeightedScope: number
  /** Avanço aceito ponderado (0-1) ou null se dados insuficientes. */
  acceptedAdvancement: number | null
  /** Progresso operacional (0-1) — inclui em execução, não é aceite. */
  operationalProgress: number | null
  /** Quantidade de subtarefas bloqueadas ativas. */
  blockedItems: number
  /** Primeira aprovação (0-1) ou null. */
  firstAttemptApprovalRate: number | null
  /** Taxa de retrabalho (0-1) ou null. */
  reworkRate: number | null
  /** Taxa de bloqueio (0-1) ou null. */
  blockerRate: number | null
  /** Lead time mediano em segundos ou null. */
  medianLeadTimeSeconds: number | null
  /** Tempo bloqueado total em segundos. */
  totalBlockedTimeSeconds: number
  /** Sucesso de gates (0-1) ou null. */
  gateSuccessRate: number | null
  /** Confiabilidade pós-deploy (0-1) ou null. */
  deployReliability: number | null
  /** Qualidade dos dados usados no cálculo. */
  dataQuality: DataQuality
  /** Período do filtro aplicado. */
  filter: MetricsFilter
  /** Timestamp do cálculo. */
  computedAt: Date
}

/** Linha de subtarefa para cálculo de KPIs. */
export interface SubtaskMetricsRow {
  id: number
  status: string
  weight: number | null
  planned_start: Date | null
  planned_end: Date | null
  created_at: Date
  verified_at: Date | null
  superseded_by_subtask_id: number | null
  /** Número da tentativa em que foi verificada (null se não verified). */
  verified_attempt: number | null
  /** Total de tentativas registradas. */
  attempt_count: number
  /** Se possui bloqueio aberto ou resolvido. */
  has_blocker: boolean
}

/** Linha de tentativa para cálculo de cobertura. */
export interface AttemptMetricsRow {
  id: number
  subtask_id: number
  attempt_number: number
  started_at: Date
  finished_at: Date | null
  outcome: string
  duration_ms: number | null
  gate_count: number
}

/** Linha de gate para cálculo de sucesso. */
export interface GateMetricsRow {
  id: number
  attempt_id: number
  gate_type: string
  status: string
}

/** Linha de deploy para confiabilidade. */
export interface DeployMetricsRow {
  id: string
  deployed_at: Date | null
  smoke_test_ok: boolean | null
}

// ============================================================================
// PURE CALCULATION FUNCTIONS (testable without DB)
// ============================================================================

/**
 * Calcula o avanço aceito ponderado.
 * @returns valor 0-1 ou null se denominador = 0.
 */
export function computeAcceptedAdvancement(
  subtasks: SubtaskMetricsRow[],
): { value: number | null; totalWeight: number; acceptedWeight: number } {
  const denominatorRows: SubtaskDenominatorRow[] = subtasks.map((s) => ({
    id: s.id,
    status: s.status,
    supersededBySubtaskId: s.superseded_by_subtask_id,
  }))
  const { eligibleIds } = computeSubtaskDenominator(denominatorRows)

  if (eligibleIds.length === 0) {
    return { value: null, totalWeight: 0, acceptedWeight: 0 }
  }

  const eligibleSubtasks = subtasks.filter((s) => eligibleIds.includes(s.id))
  let totalWeight = 0
  let acceptedWeight = 0

  for (const st of eligibleSubtasks) {
    const weight = st.weight ?? 1 // default weight = 1 when not set
    totalWeight += weight
    const normalizedStatus = (st.status as SubTaskStatusValue)
    const category = SUBTASK_STATUS_CATEGORIES[normalizedStatus]
    if (category === "accepted") {
      acceptedWeight += weight
    }
  }

  if (totalWeight === 0) {
    return { value: null, totalWeight: 0, acceptedWeight: 0 }
  }

  return { value: acceptedWeight / totalWeight, totalWeight, acceptedWeight }
}

/**
 * Calcula o progresso operacional (inclui em execução, não é aceite).
 * @returns valor 0-1 ou null se denominador = 0.
 */
export function computeOperationalProgress(
  subtasks: SubtaskMetricsRow[],
): { value: number | null; operationalCount: number; total: number } {
  const denominatorRows: SubtaskDenominatorRow[] = subtasks.map((s) => ({
    id: s.id,
    status: s.status,
    supersededBySubtaskId: s.superseded_by_subtask_id,
  }))
  const { eligibleIds } = computeSubtaskDenominator(denominatorRows)

  if (eligibleIds.length === 0) {
    return { value: null, operationalCount: 0, total: 0 }
  }

  const eligibleSubtasks = subtasks.filter((s) => eligibleIds.includes(s.id))
  let operationalCount = 0

  for (const st of eligibleSubtasks) {
    const normalizedStatus = (st.status as SubTaskStatusValue)
    const category = SUBTASK_STATUS_CATEGORIES[normalizedStatus]
    if (category === "operational" || category === "accepted") {
      operationalCount++
    }
  }

  return { value: operationalCount / eligibleIds.length, operationalCount, total: eligibleIds.length }
}

/**
 * Taxa de aprovação na primeira tentativa.
 * @returns valor 0-1 ou null se não há subtarefas verified.
 */
export function computeFirstAttemptApprovalRate(
  subtasks: SubtaskMetricsRow[],
): { value: number | null; firstAttemptCount: number; verifiedCount: number } {
  const verifiedSubtasks = subtasks.filter(
    (s) => (s.status as SubTaskStatusValue) === "verified" || (s.status as SubTaskStatusValue) === "completed",
  )

  if (verifiedSubtasks.length === 0) {
    return { value: null, firstAttemptCount: 0, verifiedCount: 0 }
  }

  const firstAttempt = verifiedSubtasks.filter((s) => s.verified_attempt === 1)

  return {
    value: firstAttempt.length / verifiedSubtasks.length,
    firstAttemptCount: firstAttempt.length,
    verifiedCount: verifiedSubtasks.length,
  }
}

/**
 * Taxa de retrabalho: subtarefas com mais de uma tentativa / subtarefas iniciadas.
 * @returns valor 0-1 ou null se não há subtarefas iniciadas.
 */
export function computeReworkRate(
  subtasks: SubtaskMetricsRow[],
): { value: number | null; reworkCount: number; startedCount: number } {
  const startedSubtasks = subtasks.filter((s) => s.attempt_count > 0)

  if (startedSubtasks.length === 0) {
    return { value: null, reworkCount: 0, startedCount: 0 }
  }

  const reworkCount = startedSubtasks.filter((s) => s.attempt_count > 1).length

  return { value: reworkCount / startedSubtasks.length, reworkCount, startedCount: startedSubtasks.length }
}

/**
 * Taxa de bloqueio: subtarefas com bloqueio / subtarefas iniciadas.
 * @returns valor 0-1 ou null se não há subtarefas iniciadas.
 */
export function computeBlockerRate(
  subtasks: SubtaskMetricsRow[],
): { value: number | null; blockedCount: number; startedCount: number } {
  const startedSubtasks = subtasks.filter((s) => s.attempt_count > 0)

  if (startedSubtasks.length === 0) {
    return { value: null, blockedCount: 0, startedCount: 0 }
  }

  const blockedCount = startedSubtasks.filter((s) => s.has_blocker).length

  return { value: blockedCount / startedSubtasks.length, blockedCount, startedCount: startedSubtasks.length }
}

/**
 * Lead time mediano (criação → verified_at) em segundos.
 * @returns mediana em segundos ou null se não há dados.
 */
export function computeMedianLeadTimeSeconds(
  subtasks: SubtaskMetricsRow[],
): { value: number | null; count: number } {
  const verifiedSubtasks = subtasks.filter(
    (s) => s.verified_at != null && ((s.status as SubTaskStatusValue) === "verified" || (s.status as SubTaskStatusValue) === "completed"),
  )

  if (verifiedSubtasks.length === 0) {
    return { value: null, count: 0 }
  }

  const leadTimes = verifiedSubtasks
    .map((s) => (s.verified_at!.getTime() - s.created_at.getTime()) / 1000)
    .filter((t) => t >= 0)
    .sort((a, b) => a - b)

  if (leadTimes.length === 0) {
    return { value: null, count: 0 }
  }

  const median = computeMedian(leadTimes)
  return { value: median, count: leadTimes.length }
}

/**
 * Calcula a mediana de um array ordenado de números.
 */
export function computeMedian(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  return sorted[mid]!
}

/**
 * Sucesso de gates: gates passed / gates executados.
 * @returns valor 0-1 ou null se não há gates.
 */
export function computeGateSuccessRate(
  gates: GateMetricsRow[],
): { value: number | null; passedCount: number; totalCount: number } {
  if (gates.length === 0) {
    return { value: null, passedCount: 0, totalCount: 0 }
  }

  const passedCount = gates.filter((g) => g.status === "passed").length

  return { value: passedCount / gates.length, passedCount, totalCount: gates.length }
}

/**
 * Confiabilidade pós-deploy: deploys com smoke aprovado / deploys realizados.
 * @returns valor 0-1 ou null se não há deploys.
 */
export function computeDeployReliability(
  deploys: DeployMetricsRow[],
): { value: number | null; reliableCount: number; totalCount: number } {
  const withDeploy = deploys.filter((d) => d.deployed_at != null)

  if (withDeploy.length === 0) {
    return { value: null, reliableCount: 0, totalCount: 0 }
  }

  const reliableCount = withDeploy.filter((d) => d.smoke_test_ok === true).length

  return { value: reliableCount / withDeploy.length, reliableCount, totalCount: withDeploy.length }
}

/**
 * Calcula a qualidade dos dados para os KPIs.
 */
export function computeDataQuality(
  subtasks: SubtaskMetricsRow[],
  attempts: AttemptMetricsRow[],
  gates: GateMetricsRow[],
): DataQuality {
  const warnings: string[] = []
  const eligibleSubtasks = subtasks.filter((s) => {
    const category = SUBTASK_STATUS_CATEGORIES[(s.status as SubTaskStatusValue)]
    return category !== "excluded"
  })

  const total = eligibleSubtasks.length

  const weightCoverage = total > 0
    ? eligibleSubtasks.filter((s) => s.weight != null).length / total
    : 0

  const deadlineCoverage = total > 0
    ? eligibleSubtasks.filter((s) => s.planned_start != null && s.planned_end != null).length / total
    : 0

  const durationCoverage = attempts.length > 0
    ? attempts.filter((a) => a.duration_ms != null).length / attempts.length
    : 0

  const gateCoverage = attempts.length > 0
    ? attempts.filter((a) => a.gate_count > 0).length / attempts.length
    : 0

  if (total === 0) {
    warnings.push("Nenhuma subtarefa elegível encontrada para o filtro.")
  }
  if (weightCoverage < 0.5 && total > 0) {
    warnings.push(`Cobertura de pesos baixa (${(weightCoverage * 100).toFixed(0)}%). KPIs de avanço ponderado podem ser imprecisos.`)
  }
  if (deadlineCoverage < 0.5 && total > 0) {
    warnings.push(`Cobertura de prazos baixa (${(deadlineCoverage * 100).toFixed(0)}%). Lead time planejado não pode ser calculado.`)
  }
  if (durationCoverage < 0.5 && attempts.length > 0) {
    warnings.push(`Cobertura de duração baixa (${(durationCoverage * 100).toFixed(0)}%). Tempos de execução podem ser incompletos.`)
  }
  if (gateCoverage < 0.5 && attempts.length > 0) {
    warnings.push(`Cobertura de gates baixa (${(gateCoverage * 100).toFixed(0)}%). Sucesso de gates pode não ser representativo.`)
  }

  return { weightCoverage, deadlineCoverage, durationCoverage, gateCoverage, warnings }
}

// ============================================================================
// REPOSITORY (DB-BACKED QUERIES)
// ============================================================================

/**
 * Repositório de métricas — consulta o banco e calcula KPIs.
 */
export class AdvancementMetricsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Busca subtarefas com dados necessários para cálculo de KPIs.
   */
  async fetchSubtasks(filter: MetricsFilter): Promise<SubtaskMetricsRow[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.projectId != null) {
      conditions.push("t.projeto_id = ?")
      params.push(filter.projectId)
    }
    if (filter.taskId != null) {
      conditions.push("s.tarefa_id = ?")
      params.push(filter.taskId)
    }
    if (filter.from != null) {
      conditions.push("s.created_at >= ?")
      params.push(filter.from)
    }
    if (filter.to != null) {
      conditions.push("s.created_at <= ?")
      params.push(filter.to)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    const { rows } = await this.db.query(
      `SELECT
         s.id,
         s.status,
         s.weight,
         s.planned_start,
         s.planned_end,
         s.created_at,
         s.verified_at,
         s.superseded_by_subtask_id,
         (SELECT MIN(ea.attempt_number)
          FROM execution_attempts ea
          WHERE ea.subtask_id = s.id
            AND ea.outcome IN ('verified', 'completed')) AS verified_attempt,
         (SELECT COUNT(*)
          FROM execution_attempts ea
          WHERE ea.subtask_id = s.id) AS attempt_count,
         (SELECT COUNT(*) > 0
          FROM bloqueios b
          WHERE b.subtarefa_id = s.id) AS has_blocker
       FROM subtarefas s
       JOIN tarefas t ON t.id = s.tarefa_id
       ${where}
       ORDER BY s.id`,
      params,
    )

    return rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      status: String(row.status),
      weight: row.weight != null ? Number(row.weight) : null,
      planned_start: row.planned_start ? new Date(String(row.planned_start)) : null,
      planned_end: row.planned_end ? new Date(String(row.planned_end)) : null,
      created_at: new Date(String(row.created_at)),
      verified_at: row.verified_at ? new Date(String(row.verified_at)) : null,
      superseded_by_subtask_id: row.superseded_by_subtask_id ? Number(row.superseded_by_subtask_id) : null,
      verified_attempt: row.verified_attempt != null ? Number(row.verified_attempt) : null,
      attempt_count: Number(row.attempt_count),
      has_blocker: Boolean(row.has_blocker),
    }))
  }

  /**
   * Busca tentativas para cálculo de cobertura.
   */
  async fetchAttempts(filter: MetricsFilter): Promise<AttemptMetricsRow[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.projectId != null) {
      conditions.push("t.projeto_id = ?")
      params.push(filter.projectId)
    }
    if (filter.taskId != null) {
      conditions.push("s.tarefa_id = ?")
      params.push(filter.taskId)
    }
    if (filter.from != null) {
      conditions.push("ea.started_at >= ?")
      params.push(filter.from)
    }
    if (filter.to != null) {
      conditions.push("ea.started_at <= ?")
      params.push(filter.to)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    const { rows } = await this.db.query(
      `SELECT
         ea.id,
         ea.subtask_id,
         ea.attempt_number,
         ea.started_at,
         ea.finished_at,
         ea.outcome,
         TIMESTAMPDIFF(MILLISECOND, ea.started_at, COALESCE(ea.finished_at, NOW())) AS duration_ms,
         (SELECT COUNT(*) FROM gate_runs gr WHERE gr.attempt_id = ea.id) AS gate_count
       FROM execution_attempts ea
       JOIN subtarefas s ON s.id = ea.subtask_id
       JOIN tarefas t ON t.id = s.tarefa_id
       ${where}
       ORDER BY ea.id`,
      params,
    )

    return rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      subtask_id: Number(row.subtask_id),
      attempt_number: Number(row.attempt_number),
      started_at: new Date(String(row.started_at)),
      finished_at: row.finished_at ? new Date(String(row.finished_at)) : null,
      outcome: String(row.outcome),
      duration_ms: row.duration_ms != null ? Number(row.duration_ms) : null,
      gate_count: Number(row.gate_count),
    }))
  }

  /**
   * Busca gates para cálculo de sucesso.
   */
  async fetchGates(filter: MetricsFilter): Promise<GateMetricsRow[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.projectId != null) {
      conditions.push("t.projeto_id = ?")
      params.push(filter.projectId)
    }
    if (filter.taskId != null) {
      conditions.push("s.tarefa_id = ?")
      params.push(filter.taskId)
    }
    if (filter.from != null) {
      conditions.push("gr.started_at >= ?")
      params.push(filter.from)
    }
    if (filter.to != null) {
      conditions.push("gr.started_at <= ?")
      params.push(filter.to)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    const { rows } = await this.db.query(
      `SELECT gr.id, gr.attempt_id, gr.gate_type, gr.status
       FROM gate_runs gr
       JOIN execution_attempts ea ON ea.id = gr.attempt_id
       JOIN subtarefas s ON s.id = ea.subtask_id
       JOIN tarefas t ON t.id = s.tarefa_id
       ${where}
       ORDER BY gr.id`,
      params,
    )

    return rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      attempt_id: Number(row.attempt_id),
      gate_type: String(row.gate_type),
      status: String(row.status),
    }))
  }

  /**
   * Busca deploys para confiabilidade pós-deploy.
   */
  async fetchDeploys(filter: MetricsFilter): Promise<DeployMetricsRow[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.projectId != null) {
      conditions.push("t.projeto_id = ?")
      params.push(filter.projectId)
    }
    if (filter.taskId != null) {
      conditions.push("t.id = ?")
      params.push(filter.taskId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    const { rows } = await this.db.query(
      `SELECT t.id, t.deployed_at, t.smoke_test_ok
       FROM tarefas t
       ${where}
       ORDER BY t.id`,
      params,
    )

    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      deployed_at: row.deployed_at ? new Date(String(row.deployed_at)) : null,
      smoke_test_ok: row.smoke_test_ok === true || row.smoke_test_ok === 1 ? true : row.smoke_test_ok === false || row.smoke_test_ok === 0 ? false : null,
    }))
  }

  /**
   * Calcula tempo bloqueado total para o filtro.
   */
  async fetchBlockedTimeSeconds(filter: MetricsFilter): Promise<number> {
    const conditions: string[] = ["b.resolved_at IS NOT NULL OR b.resolved_at IS NULL"]
    const params: unknown[] = []

    if (filter.projectId != null) {
      conditions.push("t.projeto_id = ?")
      params.push(filter.projectId)
    }
    if (filter.taskId != null) {
      conditions.push("b.tarefa_id = ?")
      params.push(filter.taskId)
    }
    if (filter.from != null) {
      conditions.push("b.blocked_at >= ?")
      params.push(filter.from)
    }
    if (filter.to != null) {
      conditions.push("b.blocked_at <= ?")
      params.push(filter.to)
    }

    const where = `WHERE ${conditions.join(" AND ")}`

    const { rows } = await this.db.query(
      `SELECT COALESCE(SUM(
         TIMESTAMPDIFF(SECOND, b.blocked_at, COALESCE(b.resolved_at, NOW()))
       ), 0) AS total_blocked_seconds
       FROM bloqueios b
       JOIN tarefas t ON t.id = b.tarefa_id
       ${where}`,
      params,
    )

    return Number(rows[0]?.total_blocked_seconds ?? 0)
  }

  /**
   * Calcula todos os KPIs para o filtro.
   */
  async compute(filter: MetricsFilter = {}): Promise<AdvancementMetricsResult> {
    const [subtasks, attempts, gates, deploys, blockedTime] = await Promise.all([
      this.fetchSubtasks(filter),
      this.fetchAttempts(filter),
      this.fetchGates(filter),
      this.fetchDeploys(filter),
      this.fetchBlockedTimeSeconds(filter),
    ])

    const accepted = computeAcceptedAdvancement(subtasks)
    const operational = computeOperationalProgress(subtasks)
    const firstApproval = computeFirstAttemptApprovalRate(subtasks)
    const rework = computeReworkRate(subtasks)
    const blocker = computeBlockerRate(subtasks)
    const leadTime = computeMedianLeadTimeSeconds(subtasks)
    const gateSuccess = computeGateSuccessRate(gates)
    const deployRel = computeDeployReliability(deploys)
    const quality = computeDataQuality(subtasks, attempts, gates)

    return {
      totalWeightedScope: accepted.totalWeight,
      acceptedAdvancement: accepted.value,
      operationalProgress: operational.value,
      blockedItems: subtasks.filter((s) => (s.status as SubTaskStatusValue) === "blocked").length,
      firstAttemptApprovalRate: firstApproval.value,
      reworkRate: rework.value,
      blockerRate: blocker.value,
      medianLeadTimeSeconds: leadTime.value,
      totalBlockedTimeSeconds: blockedTime,
      gateSuccessRate: gateSuccess.value,
      deployReliability: deployRel.value,
      dataQuality: quality,
      filter,
      computedAt: new Date(),
    }
  }
}
