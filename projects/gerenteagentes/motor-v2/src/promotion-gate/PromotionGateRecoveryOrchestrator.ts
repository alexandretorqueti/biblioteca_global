import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Db } from "../shared/types/infrastructure.js"
import { createLogger, describeError } from "../shared/logger.js"
import { TaskFactsStore } from "../database/TaskFactsStore.js"
import { PROMOTION_BLOCKER_SQL_FILTER } from "../policies/PromotionBlockers.js"
import { verifyWorkspacePromotionGate } from "./WorkspacePromotionGate.js"
import type { PromotionGateReport } from "./PromotionGateVerifier.js"

export interface PromotionGateRecoveryCandidate { taskId: string; repoPath: string; baseBranch: string; taskBranch: string }
export interface PromotionGateRecoveryPort {
  recoverPromotionGate(candidate: PromotionGateRecoveryCandidate, report: PromotionGateReport): Promise<void>
  /** Encerra bloqueio de promoção obsoleto que mantém uma corretiva do gate presa em `pending`. */
  releaseStalePromotionBlocker(taskId: string): Promise<void>
}

/** Verificação do gate em worktree isolado (mutável: injetável em teste). */
export type PromotionGateRecoveryVerifier = (candidate: PromotionGateRecoveryCandidate) => PromotionGateReport

/**
 * Erros em que o SQL divergiu do schema real. Sem tratamento dedicado o gate
 * ficaria silenciosamente inerte (era o caso do filtro por `tarefas.status`,
 * coluna inexistente — o estado é derivado).
 */
const SCHEMA_ERROR_PATTERN = /ER_BAD_FIELD_ERROR|ER_NO_SUCH_TABLE|Unknown column|doesn't exist|does not exist/i

/** Abre worktree `--detach` da branch preservada e roda o gate puro. */
export function verifyCandidateInWorktree(candidate: PromotionGateRecoveryCandidate): PromotionGateReport {
  const path = mkdtempSync(join(tmpdir(), "motor-promotion-gate-"))
  try {
    execFileSync("git", ["worktree", "add", "--detach", path, candidate.taskBranch], { cwd: candidate.repoPath, stdio: "pipe", timeout: 120_000 })
    return verifyWorkspacePromotionGate({ worktreePath: path, baseBranch: candidate.baseBranch })
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", path], { cwd: candidate.repoPath, stdio: "pipe", timeout: 120_000 })
    rmSync(path, { recursive: true, force: true })
  }
}

/**
 * Revisa pendências de promoção no boot/pump. O GET_LOCK do MySQL é global,
 * portanto inclusive duas instâncias do Motor só processam uma por vez.
 */
export class PromotionGateRecoveryOrchestrator {
  private running = false
  private readonly logger = createLogger("PromotionGateRecoveryOrchestrator")
  private readonly facts: TaskFactsStore
  constructor(
    private readonly db: Db,
    private readonly port: PromotionGateRecoveryPort,
    private readonly verify: PromotionGateRecoveryVerifier = verifyCandidateInWorktree,
  ) {
    this.facts = new TaskFactsStore(db)
  }

  async reconcile(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const { rows: locks } = await this.db.query("SELECT GET_LOCK('motor:promotion-gate-recovery', 0) AS acquired")
      if (Number(locks[0]?.acquired ?? 0) !== 1) return
      try {
        const candidate = await this.nextCandidate()
        if (candidate) {
          const report = this.verify(candidate)
          if (!report.ok) await this.port.recoverPromotionGate(candidate, report)
        }
        await this.releaseStaleBlockers()
      } finally {
        await this.db.query("DO RELEASE_LOCK('motor:promotion-gate-recovery')").catch(() => undefined)
      }
    } catch (error) {
      const message = describeError(error)
      if (SCHEMA_ERROR_PATTERN.test(message)) {
        this.logger.error("Reconciliação do gate de promoção falhou por divergência de schema (gate inerte): " + message)
      } else {
        this.logger.error("Falha ao reconciliar gate de promoção: " + message)
      }
    } finally { this.running = false }
  }

  /**
   * Varre corretivas do próprio gate que ficaram presas atrás de um bloqueio de
   * promoção obsoleto. Acontece quando a corretiva foi criada por uma versão do
   * gate que ainda não encerrava o bloqueio, ou quando o processo morre entre
   * criar a corretiva e encerrar o bloqueio. Como `selectNextSubtask` ignora
   * tarefas com bloqueio ativo, a correção nunca seria executada: a pendência
   * ficaria pendurada para sempre. Idempotente e limitada a tarefas que ainda
   * não foram integradas.
   */
  private async releaseStaleBlockers(): Promise<void> {
    const { rows } = await this.db.query(
      "SELECT DISTINCT t.id, t.external_id FROM tarefas t " +
      "INNER JOIN bloqueios b ON b.tarefa_id = t.id AND b.resolved_at IS NULL AND b.subtarefa_id IS NULL " +
      "WHERE " + PROMOTION_BLOCKER_SQL_FILTER + " " +
      "AND EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status IN ('pending', 'running') " +
      "AND s.correction_fingerprint LIKE 'promotion-gate:%') " +
      "AND NOT EXISTS (SELECT 1 FROM task_runtime_facts f WHERE f.tarefa_id = t.id " +
      "AND (f.integration_confirmed_at IS NOT NULL OR f.terminal_status IS NOT NULL)) " +
      "LIMIT 5",
    )
    for (const row of rows) {
      const taskId = String(row.external_id ?? row.id ?? "")
      if (!taskId) continue
      await this.port.releaseStalePromotionBlocker(taskId)
    }
  }

  /**
   * Seleciona a pendência de promoção mais antiga.
   *
   * O estado NÃO é lido de `tarefas.status` — essa coluna não existe no banco
   * do Motor; o status operacional é derivado (TaskFactsStore/DerivedTaskStatus).
   * A consulta usa apenas fatos persistidos e **confirma** o candidato com
   * `derive() === 'blocked'` antes de verificar, evitando tarefas que na prática
   * já foram integradas/deployadas (bloqueio obsoleto).
   *
   * Tarefas com análise de conflito em andamento ficam para o fluxo
   * especializado; as demais (inclusive pendências que o fluxo de conflito já
   * abandonou) permanecem alcançáveis pelo gate.
   */
  async nextCandidate(): Promise<PromotionGateRecoveryCandidate | null> {
    const { rows } = await this.db.query(
      "SELECT t.id, t.external_id, pmc.repo_path, COALESCE(NULLIF(pmc.branch_trabalho, ''), 'base-desenvolvimento') AS base_branch " +
      "FROM tarefas t " +
      "INNER JOIN projeto_motor_config pmc ON pmc.projeto_id = t.projeto_id " +
      "LEFT JOIN task_runtime_facts f ON f.tarefa_id = t.id " +
      "WHERE pmc.repo_path IS NOT NULL AND pmc.repo_path != '' " +
      "AND EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id) " +
      "AND NOT EXISTS (SELECT 1 FROM subtarefas s WHERE s.tarefa_id = t.id AND s.status NOT IN ('verified', 'superseded')) " +
      "AND EXISTS (SELECT 1 FROM bloqueios b WHERE b.tarefa_id = t.id AND b.resolved_at IS NULL) " +
      "AND f.terminal_status IS NULL " +
      "AND f.integration_confirmed_at IS NULL " +
      "AND (t.paused_at IS NULL OR t.resource_wait_key IS NOT NULL) " +
      "AND NOT EXISTS (SELECT 1 FROM deploy_requests d WHERE d.tarefa_id = t.id AND d.status = 'succeeded') " +
      "AND NOT EXISTS (SELECT 1 FROM promotion_conflict_analyses a WHERE a.tarefa_id = t.id AND a.status = 'analyzing') " +
      "ORDER BY t.updated_at ASC LIMIT 10",
    )
    for (const row of rows) {
      const taskId = String(row.external_id ?? "")
      if (!taskId || !row.repo_path) continue
      const status = await this.facts.derive(taskId)
      if (status !== "blocked") continue
      return {
        taskId,
        repoPath: String(row.repo_path),
        baseBranch: String(row.base_branch),
        taskBranch: `motor-v2/${taskId}/integracao`,
      }
    }
    return null
  }
}
