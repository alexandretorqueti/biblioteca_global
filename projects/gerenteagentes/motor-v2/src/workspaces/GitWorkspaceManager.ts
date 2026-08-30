import { execFile } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { isAbsolute, relative, resolve, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface GitCommandRunner {
  run(command: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }>
}

class NodeGitCommandRunner implements GitCommandRunner {
  async run(command: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const [file, ...args] = command
    if (!file) throw new Error("comando Git vazio")
    const result = await execFileAsync(file, args, { cwd, timeout: 120_000 })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

export interface WorkspacePreparation {
  path: string
  branch: string
  baseCommit: string
}

export interface WorkspaceIntegrationInput {
  repoPath: string
  baseBranch: string
  workBranch: string
  expectedCommit: string
}

export interface WorkspaceCleanupInput {
  repoPath: string
  workspacePath: string
}

export interface PrepareWorkspaceInput {
  repoPath: string
  baseBranch: string
  taskId: string
  subtaskId: string
  attempt: number
}

function safeSegment(value: string, label: string): string {
  if (!value || value.length > 80 || value.includes("\0") || /[\\/\r\n]/.test(value)) throw new Error(`${label} inválido`)
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!normalized || normalized === "." || normalized === "..") throw new Error(`${label} inválido`)
  return normalized
}

function safeBranch(branch: string): string {
  if (!branch || branch.length > 240 || branch.includes("\0") || /[\r\n ~^:?*\\[\\]/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.startsWith("/")) {
    throw new Error("branch inválida")
  }
  return branch
}

function validCommit(commit: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(commit)
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== "" && path !== ".." && !path.startsWith(`..${"/"}`) && !isAbsolute(path)
}

/**
 * Cria um worktree exclusivo por tentativa. O repositório principal é tratado
 * apenas como fonte do commit-base e nunca recebe checkout, merge ou escrita.
 */
export class GitWorkspaceManager {
  private readonly root: string
  private readonly runner: GitCommandRunner

  constructor(options: { root: string; runner?: GitCommandRunner }) {
    if (!isAbsolute(options.root) || options.root.includes("\0") || /[\r\n]/.test(options.root)) throw new Error("raiz de workspaces inválida")
    this.root = resolve(options.root)
    this.runner = options.runner ?? new NodeGitCommandRunner()
  }

  async prepare(input: PrepareWorkspaceInput): Promise<WorkspacePreparation> {
    if (!isAbsolute(input.repoPath) || !Number.isInteger(input.attempt) || input.attempt < 1) throw new Error("pré-condição inválida para workspace")
    const task = safeSegment(input.taskId, "taskId")
    const subtask = safeSegment(input.subtaskId, "subtaskId")
    const baseBranch = safeBranch(input.baseBranch)
    const target = resolve(join(this.root, task, subtask, `a${input.attempt}`))
    if (!inside(this.root, target)) throw new Error("workspace fora da raiz segura")

    await this.markSafeDirectory(input.repoPath)
    // Falha ambiental clara: repo ausente causa "spawn git ENOENT" e entraria
    // em loop de retries no coordenador. Classificar como bloqueio ambiental.
    // Untracked files não afetam worktree/merge e não podem travar o motor
    // enquanto outra sessão mantém arquivos novos no repositório.
    const status = await this.runner.run(["git", "status", "--porcelain", "--untracked-files=no"], input.repoPath).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT") {
        throw new Error("Ambiente bloqueado: repositório não encontrado: " + input.repoPath)
      }
      throw error
    })
    if (status.stdout.trim()) throw new Error("repositório principal não está limpo")
    const baseCommit = (await this.runner.run(["git", "rev-parse", "--verify", `${baseBranch}^{commit}`], input.repoPath)).stdout.trim()
    if (!/^[a-f0-9]{7,}$/i.test(baseCommit)) throw new Error("commit-base inválido")

    const branch = `motor-v2/${task}/${subtask}/a${input.attempt}`
    await mkdir(join(this.root, task, subtask), { recursive: true })
    console.log(`[GitWorkspaceManager] Criando worktree: target=${target}, baseCommit=${baseCommit}, repoPath=${input.repoPath}`)
    try {
      const worktreeResult = await this.runner.run(["git", "worktree", "add", "--detach", target, baseCommit], input.repoPath)
      console.log(`[GitWorkspaceManager] Worktree criado: stdout=${worktreeResult.stdout.trim()}, stderr=${worktreeResult.stderr.trim()}`)
      await this.runner.run(["git", "switch", "-c", branch, baseCommit], target)
      await this.markSafeDirectory(target)
      console.log(`[GitWorkspaceManager] Worktree validado com sucesso: path=${target}, branch=${branch}`)
      return { path: target, branch, baseCommit }
    } catch (error) {
      console.error(`[GitWorkspaceManager] Erro ao criar worktree:`, error)
      // O alvo foi criado exclusivamente por esta tentativa, sempre dentro da
      // raiz dedicada; removê-lo evita worktree parcial sem tocar no repositório.
      await rm(target, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async changedPaths(workspacePath: string, baseCommit: string, commitSha: string): Promise<string[]> {
    if (!isAbsolute(workspacePath) || !/^[a-f0-9]{7,}$/i.test(baseCommit) || !/^[a-f0-9]{7,}$/i.test(commitSha)) {
      throw new Error("referência inválida para diff do workspace")
    }
    const result = await this.runner.run(["git", "diff", "--name-only", `${baseCommit}..${commitSha}`], workspacePath)
    return result.stdout.split("\n").map((path) => path.trim()).filter(Boolean)
  }

  /**
   * Integra uma branch aprovada na branch-base no repositório principal.
   * O chamador deve manter o lease do projeto durante toda a operação.
   */
  async integrate(input: WorkspaceIntegrationInput): Promise<{ mergeCommit: string }> {
    if (!isAbsolute(input.repoPath) || !validCommit(input.expectedCommit)) {
      throw new Error("pré-condição inválida para integração Git")
    }
    const baseBranch = safeBranch(input.baseBranch)
    const workBranch = safeBranch(input.workBranch)
    const status = await this.runner.run(["git", "status", "--porcelain", "--untracked-files=all"], input.repoPath)
    if (status.stdout.trim()) throw new Error("repositório principal não está limpo para integração")

    const workCommit = (await this.runner.run(["git", "rev-parse", "--verify", `${workBranch}^{commit}`], input.repoPath)).stdout.trim()
    if (!validCommit(workCommit) || workCommit.toLowerCase() !== input.expectedCommit.toLowerCase()) {
      throw new Error("commit da branch de trabalho não corresponde ao commit aprovado")
    }

    const originalBranch = (await this.runner.run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], input.repoPath)).stdout.trim()
    try {
      await this.runner.run(["git", "switch", baseBranch], input.repoPath)
      await this.runner.run(["git", "merge", "--no-ff", "--no-edit", workBranch], input.repoPath)
      const mergeCommit = (await this.runner.run(["git", "rev-parse", "--verify", "HEAD"], input.repoPath)).stdout.trim()
      if (!validCommit(mergeCommit)) throw new Error("commit de merge inválido")
      return { mergeCommit }
    } catch (error) {
      await this.runner.run(["git", "merge", "--abort"], input.repoPath).catch(() => {})
      if (originalBranch && originalBranch !== baseBranch) {
        await this.runner.run(["git", "switch", originalBranch], input.repoPath).catch(() => {})
      }
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error("Integração Git falhou: " + reason, { cause: error })
    }
  }

  /** Remove o worktree temporário sem tocar em outros diretórios do projeto. */
  async cleanup(input: WorkspaceCleanupInput): Promise<void> {
    if (!isAbsolute(input.repoPath) || !isAbsolute(input.workspacePath)) {
      throw new Error("pré-condição inválida para limpeza do workspace")
    }
    const workspacePath = resolve(input.workspacePath)
    if (!inside(this.root, workspacePath)) throw new Error("workspace fora da raiz segura")
    await this.runner.run(["git", "worktree", "remove", "--force", workspacePath], input.repoPath)
    await rm(workspacePath, { recursive: true, force: true })
  }

  private async markSafeDirectory(path: string): Promise<void> {
    await this.runner.run(["git", "config", "--global", "--add", "safe.directory", resolve(path)], process.cwd())
  }
}
