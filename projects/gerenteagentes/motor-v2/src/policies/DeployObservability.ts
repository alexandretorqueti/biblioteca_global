/**
 * Observabilidade de deploy e pós-deploy.
 *
 * Regras de negócio:
 * - `deployed` NÃO equivale a sucesso pós-deploy; exige smoke test aprovado.
 * - Cada deploy gera eventos: deploy_requested, deploy_started, deploy_succeeded/failed.
 * - Smoke test é registrado como gate_run separado (tipo "smoke_test").
 * - `smoke_test_ok` só é true quando o smoke test passa; deploy sem smoke = "não verificado".
 * - `deployed_at` é gravado quando o deploy em si termina com sucesso (independente do smoke).
 */

import type { Db } from "../shared/types/infrastructure.js"
import type { ExecutionEvent } from "../shared/types/execution-event.js"
import { randomUUID } from "node:crypto"

export type DeployOutcome = "succeeded" | "failed"
export type SmokeTestOutcome = "passed" | "failed"

export interface DeployEventInput {
  taskId: number
  batchId: string
  repoPath: string
  correlationId?: string
}

export interface RecordDeployResultInput {
  taskId: number
  batchId: string
  outcome: DeployOutcome
  deployedAt?: Date | null
  error?: string | null
  correlationId?: string
}

export interface RecordSmokeTestInput {
  taskId: number
  outcome: SmokeTestOutcome
  smokeTestAt: Date
  evidence?: unknown
  correlationId?: string
}

export interface RecordRollbackInput {
  taskId: number
  rollbackAt: Date
  incidentId?: string | null
  customerImpact?: boolean
  reason?: string | null
}

/**
 * Instrumentação de deploy e pós-deploy no banco de observabilidade.
 */
export class DeployObservability {
  constructor(private readonly db: Db) {}

  /**
   * Registra o momento em que o deploy foi concluído com sucesso.
   * NÃO marca smoke_test_ok — isso depende do smoke test separado.
   */
  async recordDeployResult(input: RecordDeployResultInput): Promise<void> {
    if (input.outcome === "succeeded") {
      const deployedAt = input.deployedAt ?? new Date()
      await this.db.query(
        `UPDATE tarefas SET deployed_at = ?, smoke_test_ok = NULL, updated_at = NOW() WHERE id = ?`,
        [deployedAt, input.taskId],
      )
    } else {
      await this.db.query(
        `UPDATE tarefas SET deployed_at = NULL, smoke_test_ok = NULL, updated_at = NOW() WHERE id = ?`,
        [input.taskId],
      )
    }
  }

  /**
   * Registra o resultado do smoke test pós-deploy.
   * Somente smoke_test_ok = true conta como confiabilidade pós-deploy.
   */
  async recordSmokeTest(input: RecordSmokeTestInput): Promise<void> {
    const ok = input.outcome === "passed"
    await this.db.query(
      `UPDATE tarefas SET smoke_test_at = ?, smoke_test_ok = ?, updated_at = NOW() WHERE id = ?`,
      [input.smokeTestAt, ok, input.taskId],
    )
  }

  /**
   * Registra rollback e impacto ao cliente.
   */
  async recordRollback(input: RecordRollbackInput): Promise<void> {
    await this.db.query(
      `UPDATE tarefas SET rollback_at = ?, incident_id = ?, customer_impact = ?, updated_at = NOW() WHERE id = ?`,
      [input.rollbackAt, input.incidentId ?? null, input.customerImpact ?? null, input.taskId],
    )
  }

  /**
   * Verifica se um deploy pode ser considerado confiável (deploy + smoke aprovado).
   * Retorna false se smoke_test_ok for NULL (não verificado) ou false.
   */
  async isDeployReliable(taskId: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT smoke_test_ok FROM tarefas WHERE id = ?`,
      [taskId],
    )
    return rows.length > 0 && rows[0]?.smoke_test_ok === true
  }

  /**
   * Calcula a confiabilidade pós-deploy para um conjunto de tarefas:
   * deploys com smoke aprovado / deploys realizados.
   * Retorna null se não houver deploys (dados insuficientes).
   */
  async computeDeployReliability(projectId?: number): Promise<{ reliable: number; total: number; rate: number } | null> {
    const projectFilter = projectId ? "AND t.projeto_id = ?" : ""
    const params = projectId ? [projectId] : []

    const { rows } = await this.db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN smoke_test_ok = true THEN 1 ELSE 0 END) AS reliable
       FROM tarefas t
       WHERE t.deployed_at IS NOT NULL ${projectFilter}`,
      params,
    )
    const total = Number(rows[0]?.total ?? 0)
    if (total === 0) return null
    const reliable = Number(rows[0]?.reliable ?? 0)
    return { reliable, total, rate: reliable / total }
  }
}

/**
 * Gera um correlation_id para agrupar eventos de uma mesma operação de deploy.
 */
export function deployCorrelationId(batchId: string): string {
  return "deploy:" + batchId + ":" + randomUUID().slice(0, 8)
}
