import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { ConsoleAgentRuntimeDriver } from "../runtime/ConsoleAgentRuntimeDriver.js"
import type { PromotionConflictCandidate, PromotionConflictEvidence, PromotionConflictResolutionResult, PromotionConflictResolverPort } from "./promotion-conflict.types.js"

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  return result.stdout.trim()
}

function resolutionBranch(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence): string {
  const task = candidate.taskId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100)
  return `motor-v2/promotion-resolution/${task}/${evidence.fingerprint.slice(0, 12)}`
}

function mission(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence, branch: string): string {
  return [
    "Você é o Monitor do Motor-v2 e recebeu uma missão de resolução de conflito Git.",
    "Trabalhe APENAS no workspace fornecido. Não faça push, não altere a base e não mude arquivos de configuração do OpenClaw.",
    `Tarefa: ${candidate.taskId}`,
    `Branch de resolução: ${branch}`,
    `Base: ${evidence.baseBranch} @ ${evidence.baseCommit}`,
    `Branch da tarefa: ${evidence.taskBranch} @ ${evidence.taskCommit}`,
    "O merge já está em andamento e contém marcadores de conflito.",
    "Resolva preservando os comportamentos necessários dos dois lados. Não escolha ours/theirs integralmente.",
    "Depois: confirme que não há marcadores, execute git diff --check e faça um commit local com mensagem 'fix(motor): resolve conflito de promoção <tarefa>'.",
    "Não rode push. Responda com um resumo curto, riscos remanescentes e os testes que executou.",
    "Arquivos conflitantes:\n" + evidence.conflictFiles.map((file) => `- ${file.path} (${file.kind})`).join("\n"),
  ].join("\n\n")
}

/**
 * Executa a tentativa limitada do Monitor em um worktree descartável.
 * A base nunca é alterada aqui: uma branch de resolução só é devolvida após
 * não haver conflitos, o diff ser válido e os gates configurados passarem.
 */
export class PromotionConflictResolver implements PromotionConflictResolverPort {
  constructor(
    private readonly driver: ConsoleAgentRuntimeDriver,
    private readonly monitorAgentId = process.env.MOTOR_MONITOR_AGENT_ID ?? "programador-senior",
    private readonly monitorModel = process.env.MOTOR_MONITOR_MODEL || undefined,
  ) {}

  async resolve(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence): Promise<PromotionConflictResolutionResult> {
    const root = await git(candidate.repoPath, "rev-parse", "--show-toplevel")
    const projectRelative = relative(root, resolve(candidate.repoPath))
    if (!projectRelative || projectRelative.startsWith("..")) return { kind: "failed", reason: "repo_path fora do repositório Git" }

    const branch = resolutionBranch(candidate, evidence)
    const worktree = await mkdtemp(join(tmpdir(), "motor-promotion-resolution-"))
    let session: Awaited<ReturnType<ConsoleAgentRuntimeDriver["createSession"]>> | undefined
    try {
      // A branch é derivada do fingerprint e pertence exclusivamente a esta
      // tentativa. Um retry pode encontrar sobra de uma execução interrompida.
      await git(root, "branch", "-D", branch).catch(() => undefined)
      await git(root, "worktree", "add", "--detach", worktree, evidence.baseCommit)
      await git(worktree, "switch", "-c", branch)
      try { await git(worktree, "merge", "--no-commit", "--no-ff", evidence.taskCommit) } catch { /* conflito esperado */ }
      const conflicts = await git(worktree, "diff", "--name-only", "--diff-filter=U")
      const projectPath = join(worktree, projectRelative)
      let report = "O conflito deixou de ser reproduzível; o merge normal foi revalidado contra a base atual."
      if (conflicts.trim()) {
        const key = `motor:promotion-resolution:${candidate.taskId}:${evidence.fingerprint.slice(0, 12)}`
        session = await this.driver.createSession({
          agentId: this.monitorAgentId,
          key,
          label: `Resolução de conflito da tarefa ${candidate.taskId}`,
          model: this.monitorModel,
          workspacePath: projectPath,
        })
        const sent = await this.driver.sendMessage({ session, message: mission(candidate, evidence, branch), idempotencyKey: evidence.fingerprint })
        const completion = await this.driver.waitForRunCompletion(session, sent.runId)
        if (completion.state !== "final") return { kind: "failed", reason: "Monitor não concluiu: " + (completion.errorMessage ?? completion.state) }
        report = completion.content ?? "Monitor resolveu o conflito e os gates passaram."
      }

      const unresolved = await git(worktree, "diff", "--name-only", "--diff-filter=U")
      if (unresolved.trim()) return { kind: "needs_human_review", report: "Monitor concluiu sem resolver todos os arquivos: " + unresolved }
      await git(worktree, "diff", "--check")
      const status = await git(worktree, "status", "--porcelain")
      if (status.trim()) await git(worktree, "add", "-A")
      const afterAdd = await git(worktree, "status", "--porcelain")
      if (afterAdd.trim()) await git(worktree, "commit", "--no-verify", "-m", `fix(motor): resolve conflito de promoção ${candidate.taskId}`)

      for (const command of [candidate.buildCommand, candidate.testCommand].filter((value): value is string => Boolean(value?.trim()))) {
        await execFileAsync("sh", ["-lc", command], { cwd: projectPath, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 })
      }
      const commit = await git(worktree, "rev-parse", "HEAD")
      return { kind: "resolved", resolutionBranch: branch, resolutionCommit: commit, report }
    } catch (error) {
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }
    } finally {
      if (session) await this.driver.closeSession(session).catch(() => undefined)
      await execFileAsync("git", ["merge", "--abort"], { cwd: worktree }).catch(() => undefined)
      await execFileAsync("git", ["worktree", "remove", "--force", worktree], { cwd: root }).catch(() => undefined)
      await rm(worktree, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
