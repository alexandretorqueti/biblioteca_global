import { execFile } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, join } from "node:path"
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
  /** Raiz do worktree Git, usada para diff, commit e limpeza. */
  path: string
  /** Diretório do projeto dentro do worktree, usado pelo agente e pelos gates. */
  projectPath: string
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

export interface TaskIntegrationInput {
  repoPath: string
  agentId: string
  /** Branch raiz do projeto (ex.: base-desenvolvimento) de onde a branch da tarefa é criada. */
  rootBaseBranch: string
  taskId: string
  /** Workspace real do agente (do Console). Se informado, worktree é criado dentro dele. */
  agentWorkspacePath?: string
}

export interface TaskBranchMergeInput {
  /** Repositório principal (fonte dos refs). */
  repoPath: string
  /** Worktree da branch da tarefa (cwd do merge). */
  taskWorktreePath: string
  workBranch: string
  expectedCommit: string
}

export type TaskBranchMergeResult =
  | { kind: "merged"; mergeCommit: string; preMergeHead: string }
  | { kind: "conflict"; conflictFiles: string[]; reason: string }

export interface TaskPromotionInput {
  repoPath: string
  baseBranch: string
  taskBranch: string
}

export type TaskPromotionResult =
  | { kind: "promoted"; mergeCommit: string }
  | { kind: "conflict"; conflictFiles: string[]; reason: string }

/**
 * Nome da branch de integração da tarefa (P1, decisão Alexandre 2026-09-05).
 * Não pode ser exatamente `motor-v2/<taskId>`: as branches de subtarefa
 * (`motor-v2/<taskId>/<subtaskId>/a<N>`) ocupam esse prefixo como diretório
 * de refs (conflito D/F no Git). O sufixo `/integracao` vive dentro do mesmo
 * diretório e ainda é coberto pela purga `motor-v2/<taskId>/*`.
 */
export function taskIntegrationBranch(taskIdSegment: string): string {
  return `motor-v2/${taskIdSegment}/integracao`
}

export interface PrepareWorkspaceInput {
  repoPath: string
  agentId: string
  baseBranch: string
  taskId: string
  subtaskId: string
  attempt: number
  /** Workspace real do agente (do Console). Se informado, worktree é criado dentro dele. */
  agentWorkspacePath?: string
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
    const repoPath = resolve(input.repoPath)
    const agentId = safeSegment(input.agentId, "agentId")
    const task = safeSegment(input.taskId, "taskId")
    const subtask = safeSegment(input.subtaskId, "subtaskId")
    const baseBranch = safeBranch(input.baseBranch)
    
    // Usa workspace do agente (do Console) se disponível; senão usa root padrão
    const workspaceRoot = input.agentWorkspacePath && isAbsolute(input.agentWorkspacePath)
      ? resolve(input.agentWorkspacePath)
      : resolve(join(this.root, agentId))
    const target = resolve(join(workspaceRoot, "worktrees", task, subtask, `a${input.attempt}`))
    // Verifica contra o workspaceRoot usado (workspace do agente OU root padrão)
    if (!inside(workspaceRoot, target)) throw new Error("workspace fora da raiz segura")

    await this.markSafeDirectory(repoPath)
    // Falha ambiental clara: repo ausente causa "spawn git ENOENT" e entraria
    // em loop de retries no coordenador. Classificar como bloqueio ambiental.
    // Untracked files não afetam worktree/merge e não podem travar o motor
    // enquanto outra sessão mantém arquivos novos no repositório.
    // Verifica se o repo tem alterações reais (ignora whitespace-at-eol para
    // não bloquear por artefatos de db:migrate em _journal.json — só newline no fim).
    const diff = await this.runner.run(["git", "diff", "--name-only", "--ignore-space-at-eol", "HEAD"], repoPath).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT") {
        throw new Error("Ambiente bloqueado: repositório não encontrado: " + input.repoPath)
      }
      throw error
    })
    // staged files also need checking (git diff HEAD misses index-only changes if working tree matches index)
    const staged = await this.runner.run(["git", "diff", "--name-only", "--cached", "--ignore-space-at-eol"], repoPath)
    const dirtyFiles = [...new Set([...diff.stdout.split("\n"), ...staged.stdout.split("\n")].map((s) => s.trim()).filter(Boolean))]
    if (dirtyFiles.length > 0) throw new Error("repositório principal não está limpo: " + dirtyFiles.join(", "))
    const repositoryRoot = resolve((await this.runner.run(["git", "rev-parse", "--show-toplevel"], repoPath)).stdout.trim())
    const projectRelativePath = relative(repositoryRoot, repoPath)
    if (projectRelativePath === ".." || projectRelativePath.startsWith(`..${"/"}`) || isAbsolute(projectRelativePath)) {
      throw new Error("repo_path fora da raiz do repositório Git")
    }
    const baseCommit = (await this.runner.run(["git", "rev-parse", "--verify", `${baseBranch}^{commit}`], repoPath)).stdout.trim()
    if (!/^[a-f0-9]{7,}$/i.test(baseCommit)) throw new Error("commit-base inválido")

    const branch = `motor-v2/${task}/${subtask}/a${input.attempt}`
    await mkdir(join(this.root, task, subtask), { recursive: true })
    // Uma tentativa anterior pode ter deixado um worktree prunable e a
    // branch ainda registrada. Elimina somente o registro obsoleto; se o
    // worktree continuar ativo, não toca nele e deixa o Git explicar o
    // conflito real.
    await this.runner.run(["git", "worktree", "prune"], repoPath).catch(() => {})
    // Força limpeza adicional: remove entrada stale que prune não conseguiu
    // apagar (permissão negada no container, paths diferentes, etc.)
    await this.runner.run(["git", "worktree", "remove", "--force", target], repoPath).catch(() => {})
    const worktrees = await this.runner.run(["git", "worktree", "list", "--porcelain"], repoPath)
    const targetIsActive = worktrees.stdout.split("\n").some((line) => line === `worktree ${target}`)
    if (!targetIsActive) await rm(target, { recursive: true, force: true })
    // Branch órfã: existe mas nenhum worktree ativo aponta para ela.
    // Típico quando tentativa anterior criou a branch mas falhou antes do merge.
    const branchExists = await this.runner.run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath)
      .then(() => true)
      .catch(() => false)
    const branchHasActiveWorktree = branchExists && worktrees.stdout.includes(branch)
    if (branchExists && !branchHasActiveWorktree && !targetIsActive) {
      logger.info(`Branch órfã detectada (sem worktree ativo): deletando ${branch}`, { taskId: input.taskId, subtaskId: input.subtaskId })
      await this.runner.run(["git", "branch", "-D", branch], repoPath).catch(() => {})
    }
    const finalBranchExists = await this.runner.run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath)
      .then(() => true)
      .catch(() => false)
    logger.info(`Criando worktree: target=${target}, baseCommit=${baseCommit}, repoPath=${input.repoPath}`, { taskId: input.taskId, subtaskId: input.subtaskId })
    try {
      const worktreeResult = finalBranchExists
        ? await this.runner.run(["git", "worktree", "add", target, branch], repoPath)
        : await this.runner.run(["git", "worktree", "add", "--detach", target, baseCommit], repoPath)
      logger.debug(`Worktree criado: stdout=${worktreeResult.stdout.trim()}, stderr=${worktreeResult.stderr.trim()}`)
      if (!finalBranchExists) {
        try {
          await this.runner.run(["git", "switch", "-c", branch, baseCommit], target)
        } catch (switchError) {
          // Branch pode ter sido criada entre o check e o switch (race condition).
          // Faz checkout na branch existente ao invés de falhar.
          if (String(switchError).includes("already exists")) {
            await this.runner.run(["git", "switch", branch], target)
          } else {
            throw switchError
          }
        }
      }
      await this.markSafeDirectory(target)
      logger.info(`Worktree validado com sucesso: path=${target}, branch=${branch}`, { taskId: input.taskId, subtaskId: input.subtaskId })
      return { path: target, projectPath: resolve(join(target, projectRelativePath)), branch, baseCommit }
    } catch (error) {
      logger.error(`Erro ao criar worktree: ${error instanceof Error ? error.message : String(error)}`, { taskId: input.taskId, subtaskId: input.subtaskId })
      // O alvo foi criado exclusivamente por esta tentativa, sempre dentro da
      // raiz dedicada; removê-lo evita worktree parcial sem tocar no repositório.
      await rm(target, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Garante a branch + worktree de integração da TAREFA (P1, 2026-09-05).
   *
   * Arquitetura aprovada pelo Alexandre: no início da execução o motor cria
   * uma pasta e uma branch para a tarefa; as subtarefas são criadas dessa
   * branch (não da base) e mergeiam nela. Só quando todas as subtarefas
   * estiverem mergeadas e a branch estiver verde é que ela vai para a base.
   *
   * Idempotente: se a branch/worktree já existem (retomada, próxima subtarefa),
   * reutiliza o estado existente — nunca reseta a branch da tarefa.
   */
  async ensureTaskIntegration(input: TaskIntegrationInput): Promise<WorkspacePreparation> {
    if (!isAbsolute(input.repoPath)) throw new Error("pré-condição inválida para integração da tarefa")
    const repoPath = resolve(input.repoPath)
    const agentId = safeSegment(input.agentId, "agentId")
    const task = safeSegment(input.taskId, "taskId")
    const rootBaseBranch = safeBranch(input.rootBaseBranch)

    const workspaceRoot = input.agentWorkspacePath && isAbsolute(input.agentWorkspacePath)
      ? resolve(input.agentWorkspacePath)
      : resolve(join(this.root, agentId))
    const target = resolve(join(workspaceRoot, "worktrees", task, "integracao"))
    if (!inside(workspaceRoot, target)) throw new Error("workspace da tarefa fora da raiz segura")

    await this.markSafeDirectory(repoPath)
    const branch = taskIntegrationBranch(task)

    // Estado existente: branch + worktree ativos → reutiliza (próxima subtarefa
    // da mesma tarefa, retomada após pause, etc.).
    await this.runner.run(["git", "worktree", "prune"], repoPath).catch(() => {})
    const worktrees = await this.runner.run(["git", "worktree", "list", "--porcelain"], repoPath)
    const targetIsActive = worktrees.stdout.split("\n").some((line) => line === `worktree ${target}`)
    const branchExists = await this.runner.run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath)
      .then(() => true)
      .catch(() => false)

    const repositoryRoot = resolve((await this.runner.run(["git", "rev-parse", "--show-toplevel"], repoPath)).stdout.trim())
    const projectRelativePath = relative(repositoryRoot, repoPath)
    if (projectRelativePath === ".." || projectRelativePath.startsWith(`..${"/"}`) || isAbsolute(projectRelativePath)) {
      throw new Error("repo_path fora da raiz do repositório Git")
    }

    if (branchExists && targetIsActive) {
      const baseCommit = (await this.runner.run(["git", "rev-parse", "--verify", `${branch}^{commit}`], repoPath)).stdout.trim()
      if (!validCommit(baseCommit)) throw new Error("commit da branch da tarefa inválido")
      await this.markSafeDirectory(target)
      logger.info(`Branch de integração da tarefa reutilizada: ${branch} (${baseCommit})`, { taskId: input.taskId })
      return { path: target, projectPath: resolve(join(target, projectRelativePath)), branch, baseCommit }
    }

    // Criação nova: exige repositório principal limpo (mesma regra do prepare
    // de subtarefa) e parte do tip da branch raiz do projeto.
    const diff = await this.runner.run(["git", "diff", "--name-only", "--ignore-space-at-eol", "HEAD"], repoPath).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === "ENOENT") throw new Error("Ambiente bloqueado: repositório não encontrado: " + input.repoPath)
      throw error
    })
    const staged = await this.runner.run(["git", "diff", "--name-only", "--cached", "--ignore-space-at-eol"], repoPath)
    const dirtyFiles = [...new Set([...diff.stdout.split("\n"), ...staged.stdout.split("\n")].map((s) => s.trim()).filter(Boolean))]
    if (dirtyFiles.length > 0) throw new Error("repositório principal não está limpo: " + dirtyFiles.join(", "))
    const baseCommit = (await this.runner.run(["git", "rev-parse", "--verify", `${rootBaseBranch}^{commit}`], repoPath)).stdout.trim()
    if (!validCommit(baseCommit)) throw new Error("commit-base inválido para branch da tarefa")

    if (branchExists && !targetIsActive) {
      // Branch sobreviveu (ex.: worktree removido manualmente): reanexa sem
      // tocar nos commits já integrados.
      await this.runner.run(["git", "worktree", "remove", "--force", target], repoPath).catch(() => {})
      await rm(target, { recursive: true, force: true })
      await this.runner.run(["git", "worktree", "add", target, branch], repoPath)
      await this.markSafeDirectory(target)
      logger.info(`Worktree da tarefa reanexado à branch existente: ${branch}`, { taskId: input.taskId })
      return { path: target, projectPath: resolve(join(target, projectRelativePath)), branch, baseCommit }
    }

    if (!branchExists && targetIsActive) {
      // Worktree órfão sem branch (estado inconsistente): descarta e recria.
      await this.runner.run(["git", "worktree", "remove", "--force", target], repoPath).catch(() => {})
      await rm(target, { recursive: true, force: true })
    }

    await mkdir(join(workspaceRoot, "worktrees", task), { recursive: true })
    try {
      await this.runner.run(["git", "worktree", "add", "--detach", target, baseCommit], repoPath)
      try {
        await this.runner.run(["git", "switch", "-c", branch, baseCommit], target)
      } catch (switchError) {
        if (String(switchError).includes("already exists")) {
          await this.runner.run(["git", "switch", branch], target)
        } else {
          throw switchError
        }
      }
      await this.markSafeDirectory(target)
      logger.info(`Branch de integração da tarefa criada: ${branch} a partir de ${rootBaseBranch} (${baseCommit})`, { taskId: input.taskId })
      return { path: target, projectPath: resolve(join(target, projectRelativePath)), branch, baseCommit }
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Mergeia a branch aprovada de uma subtarefa NA BRANCH DA TAREFA, dentro do
   * worktree da tarefa (o repositório principal não é tocado). Conflito é
   * resultado de primeira classe (não exceção): o chamador decide o fluxo
   * (agente da subtarefa resolve; escala só se falhar — decisão 2026-09-05).
   */
  async integrateIntoTaskBranch(input: TaskBranchMergeInput): Promise<TaskBranchMergeResult> {
    if (!isAbsolute(input.repoPath) || !isAbsolute(input.taskWorktreePath) || !validCommit(input.expectedCommit)) {
      throw new Error("pré-condição inválida para integração na branch da tarefa")
    }
    const workBranch = safeBranch(input.workBranch)

    const dirty = await this.runner.run(["git", "status", "--porcelain"], input.taskWorktreePath)
    if (dirty.stdout.trim()) {
      throw new Error("worktree da tarefa não está limpo para integração: " + dirty.stdout.trim().split("\n")[0])
    }
    const workCommit = (await this.runner.run(["git", "rev-parse", "--verify", `${workBranch}^{commit}`], input.repoPath)).stdout.trim()
    if (!validCommit(workCommit) || workCommit.toLowerCase() !== input.expectedCommit.toLowerCase()) {
      throw new Error("commit da branch de trabalho não corresponde ao commit aprovado")
    }

    const preMergeHead = (await this.runner.run(["git", "rev-parse", "--verify", "HEAD"], input.taskWorktreePath)).stdout.trim()
    if (!validCommit(preMergeHead)) throw new Error("HEAD da branch da tarefa inválido")

    try {
      await this.runner.run(["git", "merge", "--no-ff", "--no-edit", workBranch], input.taskWorktreePath)
      const mergeCommit = (await this.runner.run(["git", "rev-parse", "--verify", "HEAD"], input.taskWorktreePath)).stdout.trim()
      if (!validCommit(mergeCommit)) throw new Error("commit de merge inválido")
      return { kind: "merged", mergeCommit, preMergeHead }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const conflictFiles = await this.listConflictFiles(input.taskWorktreePath)
      await this.runner.run(["git", "merge", "--abort"], input.taskWorktreePath).catch(() => {})
      return { kind: "conflict", conflictFiles, reason: reason.slice(0, 500) }
    }
  }

  /** Desfaz o merge na branch da tarefa (gate de integração vermelho). */
  async revertTaskBranchMerge(taskWorktreePath: string, resetToCommit: string): Promise<void> {
    if (!isAbsolute(taskWorktreePath) || !validCommit(resetToCommit)) {
      throw new Error("pré-condição inválida para reverter merge da branch da tarefa")
    }
    await this.runner.run(["git", "merge", "--abort"], taskWorktreePath).catch(() => {})
    await this.runner.run(["git", "reset", "--hard", resetToCommit], taskWorktreePath)
  }

  /**
   * Promove a branch da tarefa para a branch-base no repositório principal
   * (merge + push). Somente quando TODAS as subtarefas estão mergeadas e o
   * gate de integração está verde. Conflito com a base (drift externo) é
   * SEMPRE resolvido por humano (decisão Alexandre 2026-09-05): o merge é
   * abortado, nada parcial é gravado, e o chamador bloqueia a tarefa.
   */
  async promoteTaskBranch(input: TaskPromotionInput): Promise<TaskPromotionResult> {
    if (!isAbsolute(input.repoPath)) throw new Error("pré-condição inválida para promoção da tarefa")
    const baseBranch = safeBranch(input.baseBranch)
    const taskBranch = safeBranch(input.taskBranch)

    const diff = await this.runner.run(["git", "diff", "--name-only", "--ignore-space-at-eol", "HEAD"], input.repoPath)
    if (diff.stdout.trim()) throw new Error("repositório principal não está limpo para promoção: " + diff.stdout.trim())

    const originalBranch = (await this.runner.run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], input.repoPath)).stdout.trim()
    try {
      await this.runner.run(["git", "switch", baseBranch], input.repoPath)
      await this.runner.run(["git", "merge", "--no-ff", "--no-edit", taskBranch], input.repoPath)
      const mergeCommit = (await this.runner.run(["git", "rev-parse", "--verify", "HEAD"], input.repoPath)).stdout.trim()
      if (!validCommit(mergeCommit)) throw new Error("commit de promoção inválido")
      await this.runner.run(["git", "push", "origin", baseBranch], input.repoPath)
      // Publica também a branch da tarefa (rastreabilidade do que foi promovido).
      await this.runner.run(["git", "push", "origin", taskBranch], input.repoPath).catch((error: unknown) => {
        logger.warn("Falha ao publicar branch da tarefa (promoção mantida): " + (error instanceof Error ? error.message : String(error)))
      })
      return { kind: "promoted", mergeCommit }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const conflictFiles = await this.listConflictFiles(input.repoPath)
      await this.runner.run(["git", "merge", "--abort"], input.repoPath).catch(() => {})
      if (originalBranch && originalBranch !== baseBranch) {
        await this.runner.run(["git", "switch", originalBranch], input.repoPath).catch(() => {})
      }
      if (conflictFiles.length > 0 || /CONFLICT|Automatic merge failed/i.test(reason)) {
        return { kind: "conflict", conflictFiles, reason: reason.slice(0, 500) }
      }
      throw new Error("Promoção da tarefa para a base falhou: " + reason, { cause: error })
    }
  }

  /** Publica uma branch no origin (durabilidade do estado da branch da tarefa). */
  async publishBranch(repoPath: string, branch: string): Promise<void> {
    if (!isAbsolute(repoPath)) throw new Error("repoPath inválido para publicação")
    const safe = safeBranch(branch)
    await this.runner.run(["git", "push", "--force-with-lease", "origin", safe], repoPath)
  }

  private async listConflictFiles(cwd: string): Promise<string[]> {
    const result = await this.runner.run(["git", "diff", "--name-only", "--diff-filter=U"], cwd).catch(() => ({ stdout: "", stderr: "" }))
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
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
      // A publicação da subtarefa envia apenas a branch temporária. Depois da
      // integração, a branch-base também precisa ser publicada antes do deploy;
      // caso contrário o host fica correto localmente, mas origin permanece
      // atrasado e a próxima execução pode partir de uma base divergente.
      await this.runner.run(["git", "push", "origin", baseBranch], input.repoPath)
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
    // Verifica se está dentro de um workspace válido:
    // - Se contém /worktrees/, extrai a raiz do próprio caminho
    // - Senão, verifica contra this.root (comportamento original)
    const marker = `/worktrees/`
    const markerIndex = workspacePath.indexOf(marker)
    if (markerIndex !== -1) {
      const workspaceRoot = workspacePath.substring(0, markerIndex)
      if (!inside(workspaceRoot, workspacePath)) throw new Error("workspace fora da raiz segura")
    } else if (!inside(this.root, workspacePath)) {
      throw new Error("workspace fora da raiz segura")
    }
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
    const taskDirectories = new Set<string>()
    for (const line of worktreeList.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        const wtPath = line.slice("worktree ".length).trim()
        // Worktrees do motor seguem os padrões:
        // - subtarefa: <workspaceRoot>/worktrees/<taskId>/<subtaskId>/a<N>
        // - integração da tarefa (P1): <workspaceRoot>/worktrees/<taskId>/integracao
        // O diretório da tarefa é derivado do segmento após /worktrees/ para
        // cobrir os dois formatos (dirname duplo varreria a raiz worktrees/).
        if (wtPath.includes(`/${taskId}/`) && this.isInsideValidWorkspace(wtPath)) {
          worktreePaths.push(wtPath)
          const marker = "/worktrees/"
          const markerIndex = wtPath.indexOf(marker)
          if (markerIndex !== -1) {
            const firstSegment = wtPath.slice(markerIndex + marker.length).split("/")[0]
            if (firstSegment) taskDirectories.add(resolve(wtPath.slice(0, markerIndex), "worktrees", firstSegment))
          }
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

    // Limpar diretórios da tarefa dentro dos workspaces dos agentes.
    for (const taskDir of taskDirectories) {
      if (this.isInsideValidWorkspace(taskDir)) await rm(taskDir, { recursive: true, force: true }).catch(() => {})
    }

    return { worktreesRemoved, branchesRemoved }
  }

  /**
   * Verifica se um caminho está dentro de um workspace válido.
   * Workspaces válidos: MOTOR_WORKSPACE_ROOT OU workspace de agente (padrão <root>/worktrees/...).
   */
  private isInsideValidWorkspace(path: string): boolean {
    const resolved = resolve(path)
    // Padrão de worktree: <workspaceRoot>/worktrees/<taskId>/<subtaskId>/a<N>
    const marker = "/worktrees/"
    const markerIndex = resolved.indexOf(marker)
    if (markerIndex !== -1) {
      const workspaceRoot = resolved.substring(0, markerIndex)
      return inside(workspaceRoot, resolved)
    }
    // Fallback: verifica contra this.root (comportamento original)
    return inside(this.root, resolved)
  }

  private async markSafeDirectory(path: string): Promise<void> {
    await this.runner.run(["git", "config", "--global", "--add", "safe.directory", resolve(path)], process.cwd())
  }
}
