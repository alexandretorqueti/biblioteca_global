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

    const status = await this.runner.run(["git", "status", "--porcelain"], input.repoPath)
    if (status.stdout.trim()) throw new Error("repositório principal não está limpo")
    const baseCommit = (await this.runner.run(["git", "rev-parse", "--verify", `${baseBranch}^{commit}`], input.repoPath)).stdout.trim()
    if (!/^[a-f0-9]{7,}$/i.test(baseCommit)) throw new Error("commit-base inválido")

    const branch = `motor-v2/${task}/${subtask}/a${input.attempt}`
    await mkdir(join(this.root, task, subtask), { recursive: true })
    try {
      await this.runner.run(["git", "worktree", "add", "--detach", target, baseCommit], input.repoPath)
      await this.runner.run(["git", "switch", "-c", branch, baseCommit], target)
      return { path: target, branch, baseCommit }
    } catch (error) {
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
}
