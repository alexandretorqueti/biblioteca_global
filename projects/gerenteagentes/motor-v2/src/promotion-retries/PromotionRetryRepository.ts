import { PROMOTION_DIRTY_SQL_FILTER } from "../policies/PromotionBlockers.js"
import type { Db } from "../shared/types/infrastructure.js"
import { identifyDirtyPromotionRetry } from "./PromotionRetryDetector.js"
import type { PromotionRetryCandidate } from "./promotion-retry.types.js"

const MAX_ATTEMPTS = 3
const BACKOFF_MINUTES = 5

/** Persistência mínima: o bloqueio é a fonte de verdade e também registra o backoff. */
export class PromotionRetryRepository {
  constructor(private readonly db: Db) {}

  async findEligibleCandidates(): Promise<PromotionRetryCandidate[]> {
    const { rows } = await this.db.query(
      "SELECT b.id AS block_id, b.tarefa_id, b.subtarefa_id, b.block_command, b.block_excerpt, b.blocked_at, " +
      "t.external_id, pc.slug AS project_slug, pmc.repo_path, pmc.branch_trabalho AS base_branch " +
      "FROM bloqueios b INNER JOIN tarefas t ON t.id = b.tarefa_id " +
      "LEFT JOIN projetos_captados pc ON pc.id = t.projeto_id " +
      "LEFT JOIN projeto_motor_config pmc ON pmc.projeto_id = pc.id " +
      "WHERE b.resolved_at IS NULL AND b.subtarefa_id IS NULL " +
      `AND ${PROMOTION_DIRTY_SQL_FILTER} ` +
      `AND b.blocked_at < DATE_SUB(NOW(), INTERVAL ${BACKOFF_MINUTES} MINUTE) ORDER BY b.blocked_at ASC LIMIT 20`,
    )
    return rows.map(identifyDirtyPromotionRetry).filter((item): item is PromotionRetryCandidate => item !== null)
      .filter((candidate) => candidate.attempt < MAX_ATTEMPTS)
  }

  /** Claim atômico: duas instâncias não podem reexecutar a mesma promoção. */
  async claim(candidate: PromotionRetryCandidate): Promise<boolean> {
    const nextAttempt = candidate.attempt + 1
    const command = `motor-v2:promotion-repo-dirty:${encodeURIComponent(candidate.baseBranch)}:${encodeURIComponent(candidate.taskBranch)}:${nextAttempt}`
    const result = await this.db.query(
      "UPDATE bloqueios SET block_command = ?, blocked_at = NOW() WHERE id = ? AND resolved_at IS NULL " +
      `AND blocked_at < DATE_SUB(NOW(), INTERVAL ${BACKOFF_MINUTES} MINUTE)`,
      [command, candidate.blockId],
    )
    return result.affectedRows > 0
  }

  async recordFailure(candidate: PromotionRetryCandidate, reason: string): Promise<void> {
    await this.db.query("UPDATE bloqueios SET block_excerpt = ? WHERE id = ? AND resolved_at IS NULL", [reason.slice(0, 2000), candidate.blockId])
  }
}
