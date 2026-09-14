import { isAbsolute, relative, resolve } from "node:path"
import { taskIntegrationBranch, type GitCommandRunner } from "../workspaces/GitWorkspaceManager.js"

const MAX_OUTPUT = 500

export interface CompletedDeploymentGitCandidate {
  /** Identificador persistido da tarefa (external_id quando disponível). */
  tarefaId: string
  /** Identificador externo usado para compor o nome da branch. */
  externalId?: string | null
  /** Caminho do projeto persistido em projetos_captados/projeto_motor_config. */
  repoPath: string
  /** Branch base persistida na configuração do projeto. */
  baseBranch: string
  /** Permite ao chamador informar a raiz persistida do workspace, quando houver. */
  workspaceRoot?: string | null
}

export type CompletedDeploymentGitClassification = "confirmed" | "inconclusive"

export interface GitCommandEvidence {
  command: string
  cwd: string
  stdout: string
  stderr: string
  result: "ok" | "failed"
}

export interface CompletedDeploymentGitEvidence {
  repoPath: string
  projectPath: string | null
  worktreePath: string | null
  baseBranch: string
  taskBranch: string
  baseSha: string | null
  taskSha: string | null
  isAncestor: boolean
  commands: GitCommandEvidence[]
}

export interface CompletedDeploymentGitResult {
  tarefaId: string
  externalId: string | null
  classification: CompletedDeploymentGitClassification
  evidence: CompletedDeploymentGitEvidence
  reason?: string
}

export interface CompletedDeploymentGitReport {
  results: CompletedDeploymentGitResult[]
  confirmed: CompletedDeploymentGitResult[]
  inconclusive: CompletedDeploymentGitResult[]
}

interface ListedWorktree {
  path: string
  branch: string | null
}

function short(value: string): string {
  const normalized = value.trim()
  return normalized.length <= MAX_OUTPUT ? normalized : normalized.slice(0, MAX_OUTPUT) + "…"
}

function validSha(value: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(value.trim())
}

function parseWorktrees(output: string): ListedWorktree[] {
  const records: ListedWorktree[] = []
  let current: ListedWorktree | null = null
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current)
      current = { path: line.slice("worktree ".length).trim(), branch: null }
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim()
    } else if (current && line === "") {
      records.push(current)
      current = null
    }
  }
  if (current) records.push(current)
  return records.filter((item) => item.path.length > 0)
}

function initialEvidence(candidate: CompletedDeploymentGitCandidate, taskBranch: string): CompletedDeploymentGitEvidence {
  return {
    repoPath: candidate.repoPath,
    projectPath: null,
    worktreePath: null,
    baseBranch: candidate.baseBranch,
    taskBranch,
    baseSha: null,
    taskSha: null,
    isAncestor: false,
    commands: [],
  }
}

/**
 * Verifica retrospectivamente se a branch de integração de uma tarefa chegou
 * à base. Todos os comandos são leitura: a classe não faz checkout, merge,
 * push, prune ou qualquer escrita em Git.
 */
export class CompletedDeploymentGitVerifier {
  constructor(private readonly runner: GitCommandRunner) {}

  async verify(candidate: CompletedDeploymentGitCandidate): Promise<CompletedDeploymentGitResult> {
    const taskSegment = candidate.externalId?.trim() || candidate.tarefaId.trim()
    const taskBranch = taskIntegrationBranch(taskSegment)
    const evidence = initialEvidence(candidate, taskBranch)
    const inconclusive = (reason: string): CompletedDeploymentGitResult => ({
      tarefaId: candidate.tarefaId,
      externalId: candidate.externalId?.trim() || null,
      classification: "inconclusive",
      evidence,
      reason,
    })

    if (!isAbsolute(candidate.repoPath) || !candidate.baseBranch || !taskSegment) return inconclusive("repo_path, branch base ou identificador inválido")

    let repositoryRoot: string
    try {
      repositoryRoot = await this.read(candidate.repoPath, ["git", "rev-parse", "--show-toplevel"], evidence)
    } catch (error) {
      return inconclusive(`não foi possível resolver a raiz do repositório: ${message(error)}`)
    }

    let worktrees: ListedWorktree[]
    try {
      const listed = await this.read(repositoryRoot, ["git", "worktree", "list", "--porcelain"], evidence)
      worktrees = parseWorktrees(listed)
    } catch (error) {
      return inconclusive(`git worktree list falhou: ${message(error)}`)
    }

    const matches = worktrees.filter((item) => item.branch === taskBranch)
    if (matches.length === 0) return inconclusive(`worktree da branch ${taskBranch} não encontrado`)
    if (matches.length > 1) return inconclusive(`mais de uma evidência de worktree para ${taskBranch}`)
    const match = matches[0]
    if (!match) return inconclusive(`worktree da branch ${taskBranch} não encontrado`)
    const worktreePath = resolve(match.path)
    evidence.worktreePath = worktreePath

    let worktreeRoot: string
    try {
      worktreeRoot = await this.read(worktreePath, ["git", "rev-parse", "--show-toplevel"], evidence)
    } catch (error) {
      return inconclusive(`não foi possível resolver a raiz do worktree: ${message(error)}`)
    }
    if (resolve(repositoryRoot) !== resolve(worktreeRoot)) return inconclusive("repo_path e worktree pertencem a repositórios divergentes")

    const projectRelative = relative(repositoryRoot, resolve(candidate.repoPath))
    if (projectRelative.startsWith(`..${"/"}`) || projectRelative === ".." || isAbsolute(projectRelative)) {
      return inconclusive("repo_path está fora da raiz do repositório Git")
    }
    evidence.projectPath = projectRelative ? resolve(worktreePath, projectRelative) : worktreePath

    try {
      const baseSha = await this.read(repositoryRoot, ["git", "rev-parse", "--verify", `${candidate.baseBranch}^{commit}`], evidence)
      const taskSha = await this.read(repositoryRoot, ["git", "rev-parse", "--verify", `${taskBranch}^{commit}`], evidence)
      if (!validSha(baseSha) || !validSha(taskSha)) return inconclusive("SHA de base ou branch da tarefa inválido")
      evidence.baseSha = baseSha.trim()
      evidence.taskSha = taskSha.trim()
    } catch (error) {
      return inconclusive(`branch base ou branch da tarefa ausente: ${message(error)}`)
    }

    try {
      await this.read(repositoryRoot, ["git", "merge-base", "--is-ancestor", evidence.taskSha, evidence.baseSha], evidence)
      evidence.isAncestor = true
      return { tarefaId: candidate.tarefaId, externalId: candidate.externalId?.trim() || null, classification: "confirmed", evidence }
    } catch (error) {
      return inconclusive(`ancestralidade não confirmada: ${message(error)}`)
    }
  }

  async verifyAll(candidates: readonly CompletedDeploymentGitCandidate[]): Promise<CompletedDeploymentGitReport> {
    const results = await Promise.all(candidates.map((candidate) => this.verify(candidate)))
    return {
      results,
      confirmed: results.filter((result) => result.classification === "confirmed"),
      inconclusive: results.filter((result) => result.classification === "inconclusive"),
    }
  }

  private async read(cwd: string, command: readonly string[], evidence: CompletedDeploymentGitEvidence): Promise<string> {
    try {
      const result = await this.runner.run(command, cwd)
      evidence.commands.push({ command: command.join(" "), cwd, stdout: short(result.stdout), stderr: short(result.stderr), result: "ok" })
      return result.stdout.trim()
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string }
      evidence.commands.push({ command: command.join(" "), cwd, stdout: short(String(failed.stdout ?? "")), stderr: short(String(failed.stderr ?? message(error))), result: "failed" })
      throw error
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
