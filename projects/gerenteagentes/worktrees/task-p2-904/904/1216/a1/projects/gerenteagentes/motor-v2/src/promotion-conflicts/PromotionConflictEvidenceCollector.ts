import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { promotionConflictFingerprint } from "./promotion-conflict-fingerprint.js"
import type { PromotionConflictCandidate, PromotionConflictEvidence, PromotionConflictFileEvidence, PromotionConflictKind } from "./promotion-conflict.types.js"

const execFileAsync = promisify(execFile)
const MAX_EXCERPT = 12_000

/**
 * O merge simulado não produz mais conflito: a branch já pode entrar na base.
 * Erro tipado para que o orquestrador recupere (promova) em vez de só registrar
 * falha — sem isso o bloqueio antigo fica preso e a análise se repete para sempre.
 */
export class ConflictNotReproducibleError extends Error {
  constructor(message = "Conflito não é mais reproduzível contra o HEAD atual da base") {
    super(message)
    this.name = "ConflictNotReproducibleError"
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trim()
}

function classify(path: string, base: string, task: string): PromotionConflictKind {
  if (/migrations\/meta\/_journal\.json$|migrations\/.*\.sql$/.test(path)) return "migration_journal"
  if (/\.(ts|tsx|js|jsx|sql|json)$/.test(path) && base && task) return "semantic"
  if (base && task) return "mechanical"
  return "unknown"
}

async function stage(cwd: string, stageNumber: 1 | 2 | 3, path: string): Promise<string> {
  try { return (await git(cwd, "show", `:${stageNumber}:${path}`)).slice(0, MAX_EXCERPT) }
  catch { return "" }
}

/** Simula o merge em worktree descartável; nunca altera a base real. */
export class PromotionConflictEvidenceCollector {
  async collect(candidate: PromotionConflictCandidate): Promise<PromotionConflictEvidence> {
    const baseCommit = await git(candidate.repoPath, "rev-parse", `${candidate.baseBranch}^{commit}`)
    const taskCommit = await git(candidate.repoPath, "rev-parse", `${candidate.taskBranch}^{commit}`)
    const mergeBase = await git(candidate.repoPath, "merge-base", baseCommit, taskCommit)
    const tempRoot = await mkdtemp(join(tmpdir(), "motor-promotion-conflict-"))

    try {
      await git(candidate.repoPath, "worktree", "add", "--detach", tempRoot, baseCommit)
      try {
        await git(tempRoot, "merge", "--no-commit", "--no-ff", taskCommit)
      } catch {
        // O conflito é o resultado esperado da simulação.
      }
      const files = (await git(tempRoot, "diff", "--name-only", "--diff-filter=U"))
        .split("\n").map((line) => line.trim()).filter(Boolean)
      if (files.length === 0) throw new ConflictNotReproducibleError()

      const conflictFiles: PromotionConflictFileEvidence[] = []
      for (const path of files) {
        const ancestorExcerpt = await stage(tempRoot, 1, path)
        const baseExcerpt = await stage(tempRoot, 2, path)
        const taskExcerpt = await stage(tempRoot, 3, path)
        conflictFiles.push({ path, kind: classify(path, baseExcerpt, taskExcerpt), baseExcerpt, taskExcerpt, ancestorExcerpt })
      }
      return {
        taskId: candidate.taskId, baseBranch: candidate.baseBranch, taskBranch: candidate.taskBranch,
        baseCommit, taskCommit, mergeBase, conflictFiles,
        fingerprint: promotionConflictFingerprint({ taskId: candidate.taskId, baseCommit, taskCommit, conflictFiles: files }),
      }
    } finally {
      await execFileAsync("git", ["merge", "--abort"], { cwd: tempRoot }).catch(() => undefined)
      await execFileAsync("git", ["worktree", "remove", "--force", tempRoot], { cwd: candidate.repoPath }).catch(() => undefined)
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

