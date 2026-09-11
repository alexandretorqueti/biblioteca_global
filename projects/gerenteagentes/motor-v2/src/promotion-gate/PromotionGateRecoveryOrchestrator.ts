import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Db } from "../shared/types/infrastructure.js"
import { createLogger, describeError } from "../shared/logger.js"
import { verifyWorkspacePromotionGate } from "./WorkspacePromotionGate.js"
import type { PromotionGateReport } from "./PromotionGateVerifier.js"

export interface PromotionGateRecoveryCandidate { taskId: string; repoPath: string; baseBranch: string; taskBranch: string }
export interface PromotionGateRecoveryPort { recoverPromotionGate(candidate: PromotionGateRecoveryCandidate, report: PromotionGateReport): Promise<void> }

/**
 * Revisa pendências de promoção no boot/pump. O GET_LOCK do MySQL é global,
 * portanto inclusive duas instâncias do Motor só processam uma por vez.
 */
export class PromotionGateRecoveryOrchestrator {
  private running = false
  private readonly logger = createLogger("PromotionGateRecoveryOrchestrator")
  constructor(private readonly db: Db, private readonly port: PromotionGateRecoveryPort) {}

  async reconcile(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const { rows: locks } = await this.db.query("SELECT GET_LOCK('motor:promotion-gate-recovery', 0) AS acquired")
      if (Number(locks[0]?.acquired ?? 0) !== 1) return
      try {
        const candidate = await this.nextCandidate()
        if (!candidate) return
        const report = this.verifyCandidate(candidate)
        if (!report.ok) await this.port.recoverPromotionGate(candidate, report)
      } finally {
        await this.db.query("DO RELEASE_LOCK('motor:promotion-gate-recovery')").catch(() => undefined)
      }
    } catch (error) {
      this.logger.error("Falha ao reconciliar gate de promoção: " + describeError(error))
    } finally { this.running = false }
  }

  private async nextCandidate(): Promise<PromotionGateRecoveryCandidate | null> {
    const { rows } = await this.db.query(
      "SELECT t.external_id, pmc.repo_path, COALESCE(NULLIF(pmc.branch_trabalho, ''), 'base-desenvolvimento') AS base_branch " +
      "FROM tarefas t INNER JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id " +
      "WHERE t.status = 'blocked' AND pmc.repo_path IS NOT NULL AND pmc.repo_path != '' " +
      "AND EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id) " +
      "AND NOT EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status NOT IN ('verified', 'superseded')) " +
      "AND NOT EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL AND (b.block_command LIKE 'motor-v2:promotion-conflict:%' OR b.block_command LIKE 'motor-v2:promotion-repo-dirty:%')) " +
      "ORDER BY t.updated_at ASC LIMIT 1",
    )
    const row = rows[0]
    if (!row?.external_id || !row.repo_path) return null
    const taskId = String(row.external_id)
    return { taskId, repoPath: String(row.repo_path), baseBranch: String(row.base_branch), taskBranch: `motor-v2/${taskId}/integracao` }
  }

  private verifyCandidate(candidate: PromotionGateRecoveryCandidate): PromotionGateReport {
    const path = mkdtempSync(join(tmpdir(), "motor-promotion-gate-"))
    try {
      execFileSync("git", ["worktree", "add", "--detach", path, candidate.taskBranch], { cwd: candidate.repoPath, stdio: "pipe", timeout: 120_000 })
      return verifyWorkspacePromotionGate({ worktreePath: path, baseBranch: candidate.baseBranch })
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", path], { cwd: candidate.repoPath, stdio: "pipe", timeout: 120_000 })
      rmSync(path, { recursive: true, force: true })
    }
  }
}
