import { PROMOTION_CONFLICT_SQL_FILTER } from "../policies/PromotionBlockers.js"
import type { Db } from "../shared/types/infrastructure.js"
import { identifyPromotionConflict } from "./PromotionConflictDetector.js"
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
