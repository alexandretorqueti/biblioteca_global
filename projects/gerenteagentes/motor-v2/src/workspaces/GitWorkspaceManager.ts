import { execFile } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { isAbsolute, relative, resolve, join } from "node:path"
import { promisify } from "node:util"
import { createLogger } from "../shared/logger.js"

const logger = createLogger("GitWorkspaceManager")

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
    // Verifica se o repo tem alterações reais (ignora whitespace-at-eol para
    // não bloquear por artefatos de db:migrate em _journal.json — só newline no fim).
    const diff = await this.runner.run(["git", "diff", "--name-only", "--ignore-space-at-eol", "HEAD"], input.repoPath).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT") {
        throw new Error("Ambiente bloqueado: repositório não encontrado: " + input.repoPath)
      }
      throw error
    })
    // staged files also need checking (git diff HEAD misses index-only changes if working tree matches index)
    const staged = await this.runner.run(["git", "diff", "--name-only", "--cached", "--ignore-space-at-eol"], input.repoPath)
    const dirtyFiles = [...new Set([...diff.stdout.split("\n"), ...staged.stdout.split("\n")].map((s) => s.trim()).filter(Boolean))]
    if (dirtyFiles.length > 0) throw new Error("repositório principal não está limpo: " + dirtyFiles.join(", "))
    const baseCommit = (await this.runner.run(["git", "rev-parse", "--verify", `${baseBranch}^{commit}`], input.repoPath)).stdout.trim()
    if (!/^[a-f0-9]{7,}$/i.test(baseCommit)) throw new Error("commit-base inválido")

    const branch = `motor-v2/${task}/${subtask}/a${input.attempt}`
    await mkdir(join(this.root, task, subtask), { recursive: true })
    // Uma tentativa anterior pode ter deixado um worktree prunable e a
    // branch ainda registrada. Elimina somente o registro obsoleto; se o
    // worktree continuar ativo, não toca nele e deixa o Git explicar o
    // conflito real.
    await this.runner.run(["git", "worktree", "prune"], input.repoPath)
    const worktrees = await this.runner.run(["git", "worktree", "list", "--porcelain"], input.repoPath)
    const targetIsActive = worktrees.stdout.split("\n").some((line) => line === `worktree ${target}`)
    if (!targetIsActive) await rm(target, { recursive: true, force: true })
    const branchExists = await this.runner.run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], input.repoPath)
      .then(() => true)
      .catch(() => false)
    logger.info(`Criando worktree: target=${target}, baseCommit=${baseCommit}, repoPath=${input.repoPath}`, { taskId: input.taskId, subtaskId: input.subtaskId })
    try {
      const worktreeResult = branchExists
        ? await this.runner.run(["git", "worktree", "add", target, branch], input.repoPath)
        : await this.runner.run(["git", "worktree", "add", "--detach", target, baseCommit], input.repoPath)
      logger.debug(`Worktree criado: stdout=${worktreeResult.stdout.trim()}, stderr=${worktreeResult.stderr.trim()}`)
      if (!branchExists) await this.runner.run(["git", "switch", "-c", branch, baseCommit], target)
      await this.markSafeDirectory(target)
      logger.info(`Worktree validado com sucesso: path=${target}, branch=${branch}`, { taskId: input.taskId, subtaskId: input.subtaskId })
      return { path: target, branch, baseCommit }
    } catch (error) {
      logger.error(`Erro ao criar worktree: ${error instanceof Error ? error.message : String(error)}`, { taskId: input.taskId, subtaskId: input.subtaskId })
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
    // Untracked files não conflitam com merge; não podem travar a integração
    // enquanto outra sessão mantém arquivos novos no repositório.
    // Ignora whitespace-at-eol (artefato de db:migrate em _journal.json).
    const diffIntegrate = await this.runner.run(["git", "diff", "--name-only", "--ignore-space-at-eol", "HEAD"], input.repoPath)
    if (diffIntegrate.stdout.trim()) throw new Error("repositório principal não está limpo para integração: " + diffIntegrate.stdout.trim())

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

  /**
   * Limpa TODOS os worktrees e branches residuais de uma tarefa finalizada.
   * Tarefas com múltiplas tentativas acumulam worktrees (a1, a2, a3...) que
   * ocupam disco. Após completion/failure/cancel, varre e remove tudo.
   */
  async purgeTaskArtifacts(input: { repoPath: string; taskId: string }): Promise<{ worktreesRemoved: number; branchesRemoved: number }> {
    if (!isAbsolute(input.repoPath)) throw new Error("repoPath inválido para purge")
    const taskId = safeSegment(input.taskId, "taskId")
    let worktreesRemoved = 0
    let branchesRemoved = 0

    // Listar worktrees do repositório e filtrar os que pertencem à tarefa
    const worktreeList = await this.runner.run(["git", "worktree", "list", "--porcelain"], input.repoPath).catch(() => ({ stdout: "", stderr: "" }))
    const worktreePaths: string[] = []
    for (const line of worktreeList.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        const wtPath = line.slice("worktree ".length).trim()
        // Worktrees do motor seguem padrão: <root>/<taskId>/<subtaskId>/a<N>
        if (wtPath.includes(`/${taskId}/`) && inside(this.root, resolve(wtPath))) {
          worktreePaths.push(wtPath)
        }
      }
    }

    for (const wtPath of worktreePaths) {
      try {
        await this.runner.run(["git", "worktree", "remove", "--force", wtPath], input.repoPath)
        await rm(wtPath, { recursive: true, force: true })
        worktreesRemoved++
      } catch {
        // Se worktree já foi removido manualmente, apenas ignore
        await rm(wtPath, { recursive: true, force: true }).catch(() => {})
      }
    }

    // Listar branches do motor-v2 para esta tarefa e removê-las
    const branchList = await this.runner.run(["git", "branch", "--list", `motor-v2/${taskId}/*`], input.repoPath).catch(() => ({ stdout: "", stderr: "" }))
    for (const line of branchList.stdout.split("\n")) {
      const branch = line.replace(/^[*\s]+/, "").trim()
      if (!branch) continue
      try {
        await this.runner.run(["git", "branch", "-D", branch], input.repoPath)
        branchesRemoved++
      } catch {
        // Branch pode já ter sido deletada; ignorar
      }
    }

    // Limpar diretórios vazios da tarefa
    const taskDir = resolve(join(this.root, taskId))
    await rm(taskDir, { recursive: true, force: true }).catch(() => {})

    return { worktreesRemoved, branchesRemoved }
  }

  private async markSafeDirectory(path: string): Promise<void> {
    await this.runner.run(["git", "config", "--global", "--add", "safe.directory", resolve(path)], process.cwd())
  }
}
