import { PROMOTION_CONFLICT_SQL_FILTER } from "../policies/PromotionBlockers.js"
import type { Db } from "../shared/types/infrastructure.js"
import { identifyPromotionConflict } from "./PromotionConflictDetector.js"
import { PROMOTION_BLOCKER_SQL_FILTER } from "../policies/PromotionBlockers.js"
import type { PromotionConflictAnalysisResult, PromotionConflictCandidate, PromotionConflictEvidence } from "./promotion-conflict.types.js"

export class PromotionConflictRepository {
  constructor(private readonly db: Db) {}

  async findPendingCandidates(): Promise<PromotionConflictCandidate[]> {
    const { rows } = await this.db.query(
      "SELECT b.id AS block_id, b.tarefa_id, b.subtarefa_id, b.block_command, b.block_excerpt, " +
      "t.external_id, pc.slug AS project_slug, pmc.repo_path, pmc.branch_trabalho AS base_branch, pmc.build_command, pmc.unit_test_command, " +
      "COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug) AS agent_id " +
      "FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id " +
      "LEFT JOIN projetos_captados pc ON pc.id = t.projeto_id " +
      "LEFT JOIN agentes a ON a.id = pc.agente_id " +
      "LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
      "WHERE b.resolved_at IS NULL AND b.subtarefa_id IS NULL " +
      `AND ${PROMOTION_CONFLICT_SQL_FILTER} ` +
      "ORDER BY b.blocked_at ASC LIMIT 20",
    )
    return rows.map(identifyPromotionConflict).filter((item): item is PromotionConflictCandidate => item !== null)
  }

  /**
   * Fatos mínimos para decidir a recuperação quando o conflito deixa de existir:
   * só promove se a tarefa ainda não está integrada/deployada e se todas as
   * subtarefas estão aprovadas.
   */
  async findTaskState(taskId: string): Promise<{ integrationConfirmed: boolean; deploySucceeded: boolean; hasUnfinishedSubtasks: boolean } | null> {
    const { rows } = await this.db.query(
      "SELECT t.id, f.integration_confirmed_at, " +
      "(SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status NOT IN ('verified', 'superseded')) AS abertas, " +
      "(SELECT COUNT(*) FROM deploy_requests d WHERE d.tarefa_id = t.id AND d.status = 'succeeded') AS deploy_ok " +
      "FROM tarefas t LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
      "WHERE t.external_id = ? OR t.id = CAST(? AS UNSIGNED) LIMIT 1",
      [taskId, taskId],
    )
    const row = rows[0]
    if (!row) return null
    return {
      integrationConfirmed: row.integration_confirmed_at != null,
      deploySucceeded: Number(row.deploy_ok ?? 0) > 0,
      hasUnfinishedSubtasks: Number(row.abertas ?? 0) > 0,
    }
  }

  /** Encerra bloqueios de promoção obsoletos (tarefa já integrada e sem conflito). */
  async resolvePromotionBlockers(taskId: string): Promise<number> {
    const result = await this.db.query(
      "UPDATE bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id SET b.resolved_at = NOW() " +
      "WHERE b.resolved_at IS NULL AND b.subtarefa_id IS NULL AND (t.external_id = ? OR t.id = CAST(? AS UNSIGNED)) AND " + PROMOTION_BLOCKER_SQL_FILTER,
      [taskId, taskId],
    )
    return result.affectedRows
  }

  async claim(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence): Promise<boolean> {
    const result = await this.db.query(
      "INSERT IGNORE INTO promotion_conflict_analyses " +
      "(tarefa_id, bloqueio_id, fingerprint, base_branch, task_branch, base_commit, task_commit, merge_base_commit, conflict_files_json, evidence_json, status, attempts, started_at, created_at, updated_at) " +
      "SELECT t.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzing', 1, NOW(), NOW(), NOW() FROM tarefas t " +
      "WHERE t.external_id = ? OR t.id = CAST(? AS UNSIGNED) LIMIT 1",
      [candidate.blockId ?? null, evidence.fingerprint, evidence.baseBranch, evidence.taskBranch,
        evidence.baseCommit, evidence.taskCommit, evidence.mergeBase,
        JSON.stringify(evidence.conflictFiles.map((file) => file.path)), JSON.stringify(evidence),
        candidate.taskId, candidate.taskId],
    )
    if (result.affectedRows > 0) return true
    const retry = await this.db.query(
      "UPDATE promotion_conflict_analyses SET status = 'analyzing', attempts = attempts + 1, started_at = NOW(), error_message = NULL, updated_at = NOW() " +
      "WHERE fingerprint = ? AND attempts < 2 AND (status = 'failed' OR (status = 'analyzing' AND updated_at < DATE_SUB(NOW(), INTERVAL 4 HOUR)))",
      [evidence.fingerprint],
    )
    return retry.affectedRows > 0
  }

  async complete(fingerprint: string, result: PromotionConflictAnalysisResult): Promise<void> {
    await this.db.query(
      "UPDATE promotion_conflict_analyses SET status = 'completed', confidence = ?, recommendation = ?, report = ?, completed_at = NOW(), updated_at = NOW() WHERE fingerprint = ?",
      [result.confidence, result.recommendation, result.report, fingerprint],
    )
  }

  async fail(fingerprint: string, error: string): Promise<void> {
    await this.db.query(
      "UPDATE promotion_conflict_analyses SET status = 'failed', error_message = ?, updated_at = NOW() WHERE fingerprint = ?",
      [error.slice(0, 2000), fingerprint],
    )
  }
}
