/**
 * ResumePreflightChecker — verificações locais somente-leitura antes de retomar
 * uma tarefa bloqueada por infraestrutura.
 *
 * Responsabilidades:
 * - Verificar raiz e estado Git sem alterar o workspace
 * - Verificar branch esperada e commit registrado da execução
 * - Verificar dependências requeridas pela execução
 * - Cada verificação retorna resultado estruturado com causa diagnóstica acionável
 *
 * NÃO cria worktrees, NÃO descarta commits, NÃO instala dependências.
 * Agrupa falhas sistêmicas em um único incidente.
 *
 * O runner de comandos Git é injetável para testes unitários.
 */

import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { createLogger } from "../shared/logger.js"

const logger = createLogger("ResumePreflightChecker")

// ─── Tipos públicos ─────────────────────────────────────────────────────────

/** Runner de comandos Git injetável para testes. */
export interface PreflightGitCommandRunner {
  run(command: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }>
}

/** Runner de comandos shell injetável para testes (dependências). */
export interface PreflightShellCommandRunner {
  run(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** Runner de requisições HTTP injetável para testes (Console). */
export interface PreflightHttpCommandRunner {
  request(options: {
    url: string
    method: "GET" | "HEAD"
    headers?: Record<string, string>
    timeoutMs: number
  }): Promise<{ status: number; body: string }>
}

/** Identificação da execução a ser retomada. */
export interface ResumePreflightInput {
  /** Caminho absoluto do repositório (repo_path do projeto). */
  repoPath: string
  /** Caminho absoluto do worktree da tentativa (se já existir). */
  worktreePath?: string
  /** Branch esperada da execução (ex.: motor-v2/task-7/13/a1). */
  expectedBranch?: string
  /** Commit SHA registrado como base da execução. */
  expectedBaseCommit?: string
  /** Commit SHA registrado como HEAD da execução (se houver entregas anteriores). */
  expectedHeadCommit?: string
  /** Caminho do projeto dentro do worktree (para verificação de escopo). */
  projectPath?: string
  /** Se deve verificar dependências (package-lock.json + node_modules). */
  checkDependencies?: boolean
  /** Timeout para verificação de dependências (ms). Default: 30s (verificação, não instalação). */
  dependencyCheckTimeoutMs?: number
  /** URL base do Console OpenClaw (ex.: http://127.0.0.1:6280). Se fornecida, valida sessão. */
  consoleBaseUrl?: string
  /** Token de autenticação do Console. Obrigatório se consoleBaseUrl fornecida. */
  consoleToken?: string
  /** Timeout para verificação do Console (ms). Default: 10s. */
  consoleCheckTimeoutMs?: number
  /** Host SSH de deploy (ex.: alexandre@192.168.1.8). Se fornecido, valida conectividade. */
  sshDeployTarget?: string
  /** Caminho da chave SSH privada para deploy. Default: /root/.ssh/id_ed25519. */
  sshDeployKeyPath?: string
  /** Caminho do arquivo known_hosts para verificação estrita. Default: /root/.ssh/known_hosts. */
  sshDeployKnownHostsPath?: string
  /** Timeout para verificação SSH (ms). Default: 15s. */
  sshDeployTimeoutMs?: number
}

/** Resultado de uma verificação individual do preflight. */
export interface PreflightCheckResult {
  /** Identificador da verificação. */
  check: PreflightCheckId
  /** Se a verificação passou. */
  ok: boolean
  /** Mensagem diagnóstica (sucesso ou falha). */
  message: string
  /** Causa raiz acionável em caso de falha. */
  cause?: string
  /** Ação recomendada para resolver a falha. */
  suggestedAction?: string
  /** Detalhes adicionais (valores observados, esperados, etc.). */
  details?: Record<string, string | number | boolean | null>
}

/** Identificadores das verificações do preflight. */
export type PreflightCheckId =
  | "git_root"
  | "git_state"
  | "worktree_exists"
  | "branch_match"
  | "base_commit_match"
  | "head_commit_valid"
  | "project_scope"
  | "dependencies_present"
  | "dependencies_consistent"
  | "console_session"
  | "ssh_deploy"

/** Resultado consolidado do preflight. */
export interface ResumePreflightReport {
  /** Se todas as verificações passaram. */
  ok: boolean
  /** Lista de todas as verificações executadas. */
  checks: PreflightCheckResult[]
  /** Verificações que falharam. */
  failures: PreflightCheckResult[]
  /** Classificação do incidente (se houver falhas). */
  incidentClassification?: IncidentClassification
  /** Mensagem consolidada para o histórico da tarefa. */
  summary: string
  /** Timestamp da verificação. */
  checkedAt: string
}

/** Classificação do incidente para agrupamento de falhas sistêmicas. */
export type IncidentClassification =
  | "git_repository_missing"
  | "git_repository_corrupted"
  | "worktree_missing"
  | "branch_diverged"
  | "commit_lost"
  | "dependencies_missing"
  | "dependencies_inconsistent"
  | "project_scope_violation"
  | "console_unreachable"
  | "ssh_deploy_unreachable"
  | "multiple_infrastructure_failures"

// ─── Runner padrão (Git) ────────────────────────────────────────────────────

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

class NodePreflightGitRunner implements PreflightGitCommandRunner {
  async run(command: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const [file, ...args] = command
    if (!file) throw new Error("comando Git vazio")
    const result = await execFileAsync(file, args, { cwd, timeout: 30_000 })
    return { stdout: result.stdout, stderr: result.stderr }
  }
}

// ─── Runner padrão (Shell) ──────────────────────────────────────────────────

import { execSync } from "node:child_process"

class NodePreflightShellRunner implements PreflightShellCommandRunner {
  async run(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const stdout = execSync(command, {
        cwd,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      return { stdout: stdout ?? "", stderr: "", exitCode: 0 }
    } catch (error: unknown) {
      const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number | null }
      return {
        stdout: typeof err.stdout === "string" ? err.stdout : err.stdout?.toString() ?? "",
        stderr: typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "",
        exitCode: err.status ?? 1,
      }
    }
  }
}

// ─── Runner padrão (HTTP para Console) ─────────────────────────────────────

class NodePreflightHttpRunner implements PreflightHttpCommandRunner {
  async request(options: {
    url: string
    method: "GET" | "HEAD"
    headers?: Record<string, string>
    timeoutMs: number
  }): Promise<{ status: number; body: string }> {
    const { default: http } = await import("node:http")
    const { default: https } = await import("node:https")
    const urlObj = new URL(options.url)
    const transport = urlObj.protocol === "https:" ? https : http

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error(`timeout após ${options.timeoutMs}ms`))
      }, options.timeoutMs)

      const req = transport.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: options.method,
          headers: options.headers ?? {},
        },
        (res) => {
          let body = ""
          res.setEncoding("utf-8")
          res.on("data", (chunk: string) => { body += chunk })
          res.on("end", () => {
            clearTimeout(timer)
            resolve({ status: res.statusCode ?? 0, body })
          })
        },
      )
      req.on("error", (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
      req.end()
    })
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function validCommit(commit: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(commit)
}

function pass(check: PreflightCheckId, message: string, details?: Record<string, string | number | boolean | null>): PreflightCheckResult {
  return { check, ok: true, message, details }
}

function fail(check: PreflightCheckId, message: string, cause: string, suggestedAction: string, details?: Record<string, string | number | boolean | null>): PreflightCheckResult {
  return { check, ok: false, message, cause, suggestedAction, details }
}

// ─── Classe ─────────────────────────────────────────────────────────────────

export class ResumePreflightChecker {
  private readonly gitRunner: PreflightGitCommandRunner
  private readonly shellRunner: PreflightShellCommandRunner
  private readonly httpRunner: PreflightHttpCommandRunner

  constructor(options?: {
    gitRunner?: PreflightGitCommandRunner
    shellRunner?: PreflightShellCommandRunner
    httpRunner?: PreflightHttpCommandRunner
  }) {
    this.gitRunner = options?.gitRunner ?? new NodePreflightGitRunner()
    this.shellRunner = options?.shellRunner ?? new NodePreflightShellRunner()
    this.httpRunner = options?.httpRunner ?? new NodePreflightHttpRunner()
  }

  /**
   * Executa o preflight consolidado de retomada.
   * Todas as verificações são SOMENTE LEITURA — nenhum workspace é alterado.
   */
  async check(input: ResumePreflightInput): Promise<ResumePreflightReport> {
    const checks: PreflightCheckResult[] = []
    const startedAt = new Date().toISOString()

    // 1. Verificar raiz Git
    const gitRootResult = await this.checkGitRoot(input.repoPath)
    checks.push(gitRootResult)

    // Se o repositório não existe ou está corrompido, não faz sentido continuar
    if (!gitRootResult.ok) {
      return this.buildReport(checks, startedAt)
    }

    const gitRoot = gitRootResult.details?.gitRoot as string

    // 2. Verificar estado Git (sem alterações destrutivas)
    const gitStateResult = await this.checkGitState(input.repoPath)
    checks.push(gitStateResult)

    // 3. Verificar worktree (se caminho fornecido)
    if (input.worktreePath) {
      const worktreeResult = await this.checkWorktreeExists(input.worktreePath)
      checks.push(worktreeResult)

      if (worktreeResult.ok) {
        // 4. Verificar branch esperada
        if (input.expectedBranch) {
          const branchResult = await this.checkBranchMatch(input.worktreePath, input.expectedBranch)
          checks.push(branchResult)
        }

        // 5. Verificar commit base registrado
        if (input.expectedBaseCommit) {
          const baseCommitResult = await this.checkBaseCommitMatch(input.worktreePath, input.expectedBaseCommit)
          checks.push(baseCommitResult)
        }

        // 6. Verificar commit HEAD (se houver entregas anteriores)
        if (input.expectedHeadCommit) {
          const headCommitResult = await this.checkHeadCommitValid(input.worktreePath, input.expectedHeadCommit)
          checks.push(headCommitResult)
        }
      }
    }

    // 7. Verificar escopo do projeto (se projectPath fornecido)
    if (input.projectPath && gitRoot) {
      const scopeResult = await this.checkProjectScope(gitRoot, input.repoPath, input.projectPath)
      checks.push(scopeResult)
    }

    // 8. Verificar dependências (se solicitado)
    if (input.checkDependencies && input.worktreePath) {
      const depsPresentResult = await this.checkDependenciesPresent(input.worktreePath)
      checks.push(depsPresentResult)

      if (depsPresentResult.ok && depsPresentResult.details?.hasLockFile) {
        const depsConsistentResult = await this.checkDependenciesConsistent(
          input.worktreePath,
          input.dependencyCheckTimeoutMs ?? 30_000,
        )
        checks.push(depsConsistentResult)
      }
    }

    // 9. Verificar sessão do Console (somente leitura, sem iniciar/substituir sessão)
    if (input.consoleBaseUrl) {
      const consoleResult = await this.checkConsoleSession(
        input.consoleBaseUrl,
        input.consoleToken,
        input.consoleCheckTimeoutMs ?? 10_000,
      )
      checks.push(consoleResult)
    }

    // 10. Verificar conectividade SSH de deploy (identidade estrita do host)
    if (input.sshDeployTarget) {
      const sshResult = await this.checkSshDeploy(
        input.sshDeployTarget,
        input.sshDeployKeyPath ?? "/root/.ssh/id_ed25519",
        input.sshDeployKnownHostsPath ?? "/root/.ssh/known_hosts",
        input.sshDeployTimeoutMs ?? 15_000,
      )
      checks.push(sshResult)
    }

    return this.buildReport(checks, startedAt)
  }

  // ─── Verificações individuais ───────────────────────────────────────────────

  /**
   * Verifica se o repositório Git existe e retorna a raiz.
   * SOMENTE LEITURA: git rev-parse --show-toplevel
   */
  private async checkGitRoot(repoPath: string): Promise<PreflightCheckResult> {
    if (!isAbsolute(repoPath)) {
      return fail(
        "git_root",
        "Caminho do repositório não é absoluto",
        "repoPath deve ser um caminho absoluto",
        "Fornecer o caminho absoluto do repositório na configuração do projeto",
        { repoPath },
      )
    }

    if (!existsSync(repoPath)) {
      return fail(
        "git_root",
        "Repositório não encontrado no disco",
        `O caminho ${repoPath} não existe`,
        "Verificar se o repo_path do projeto está correto e se o disco está montado",
        { repoPath },
      )
    }

    try {
      const result = await this.gitRunner.run(["git", "rev-parse", "--show-toplevel"], repoPath)
      const gitRoot = result.stdout.trim()
      if (!gitRoot) {
        return fail(
          "git_root",
          "Git não retornou a raiz do repositório",
          "git rev-parse --show-toplevel retornou vazio",
          "Verificar se o caminho é um repositório Git válido",
          { repoPath },
        )
      }
      return pass("git_root", "Repositório Git encontrado", { gitRoot, repoPath })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(
        "git_root",
        "Falha ao resolver raiz do repositório Git",
        message,
        "Verificar se o caminho é um repositório Git válido e se há permissão de leitura",
        { repoPath, error: message.slice(0, 200) },
      )
    }
  }

  /**
   * Verifica se o estado Git está íntegro (sem corrompimento).
   * SOMENTE LEITURA: git status --porcelain (não altera nada)
   */
  private async checkGitState(repoPath: string): Promise<PreflightCheckResult> {
    try {
      const result = await this.gitRunner.run(["git", "status", "--porcelain"], repoPath)
      // git status --porcelain retorna vazio se limpo, ou lista de arquivos se sujo
      // O importante é que o comando NÃO falhou — isso indica integridade do .git
      return pass("git_state", "Estado Git íntegro", {
        dirtyFiles: result.stdout.trim() ? result.stdout.trim().split("\n").length : 0,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(
        "git_state",
        "Repositório Git possivelmente corrompido",
        `git status falhou: ${message}`,
        "Executar 'git fsck' para diagnosticar; pode ser necessário restaurar o .git",
        { error: message.slice(0, 200) },
      )
    }
  }

  /**
   * Verifica se o worktree da tentativa existe no disco.
   * SOMENTE LEITURA: existsSync
   */
  private async checkWorktreeExists(worktreePath: string): Promise<PreflightCheckResult> {
    if (!isAbsolute(worktreePath)) {
      return fail(
        "worktree_exists",
        "Caminho do worktree não é absoluto",
        "worktreePath deve ser um caminho absoluto",
        "Fornecer o caminho absoluto do worktree persistido",
        { worktreePath },
      )
    }

    if (!existsSync(worktreePath)) {
      return fail(
        "worktree_exists",
        "Worktree não encontrado no disco",
        `O caminho ${worktreePath} não existe — o worktree pode ter sido removido ou nunca criado`,
        "Recriar o worktree via preparação normal (prepare) ou verificar se o caminho persistido está correto",
        { worktreePath },
      )
    }

    return pass("worktree_exists", "Worktree encontrado", { worktreePath })
  }

  /**
   * Verifica se a branch atual do worktree corresponde à esperada.
   * SOMENTE LEITURA: git branch --show-current
   */
  private async checkBranchMatch(worktreePath: string, expectedBranch: string): Promise<PreflightCheckResult> {
    try {
      const result = await this.gitRunner.run(["git", "branch", "--show-current"], worktreePath)
      const actualBranch = result.stdout.trim()

      if (!actualBranch) {
        return fail(
          "branch_match",
          "Worktree em estado detached HEAD",
          "git branch --show-current retornou vazio — worktree não está em nenhuma branch",
          "Verificar se o worktree foi corrompido ou se a branch foi deletada; pode ser necessário recriar",
          { expectedBranch, actualBranch: "(detached)" },
        )
      }

      if (actualBranch !== expectedBranch) {
        return fail(
          "branch_match",
          "Branch do worktree diverge da esperada",
          `Branch esperada: ${expectedBranch}, branch encontrada: ${actualBranch}`,
          "Verificar se o worktree persistido corresponde à execução correta; não trocar branches manualmente",
          { expectedBranch, actualBranch },
        )
      }

      return pass("branch_match", "Branch corresponde à esperada", { expectedBranch, actualBranch })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(
        "branch_match",
        "Falha ao verificar branch do worktree",
        message,
        "Verificar se o worktree é um repositório Git válido",
        { expectedBranch, error: message.slice(0, 200) },
      )
    }
  }

  /**
   * Verifica se o commit base registrado ainda existe e corresponde ao esperado.
   * SOMENTE LEITURA: git rev-parse --verify <branch>^{commit}
   */
  private async checkBaseCommitMatch(worktreePath: string, expectedBaseCommit: string): Promise<PreflightCheckResult> {
    if (!validCommit(expectedBaseCommit)) {
      return fail(
        "base_commit_match",
        "Commit base registrado é inválido",
        `Formato inválido: ${expectedBaseCommit}`,
        "Verificar o registro da execução no banco de dados",
        { expectedBaseCommit },
      )
    }

    try {
      // Verifica se o commit existe no repositório
      const verifyResult = await this.gitRunner.run(
        ["git", "rev-parse", "--verify", `${expectedBaseCommit}^{commit}`],
        worktreePath,
      )
      const actualCommit = verifyResult.stdout.trim()

      if (!actualCommit) {
        return fail(
          "base_commit_match",
          "Commit base não encontrado no repositório",
          `O commit ${expectedBaseCommit} não existe — pode ter sido perdido em um gc ou reset`,
          "Verificar se o repositório principal possui o commit; pode ser necessário restaurar de backup",
          { expectedBaseCommit },
        )
      }

      // Compara prefixo (commits podem ser abreviados)
      if (!actualCommit.startsWith(expectedBaseCommit) && !expectedBaseCommit.startsWith(actualCommit)) {
        return fail(
          "base_commit_match",
          "Commit base diverge do registrado",
          `Commit esperado: ${expectedBaseCommit}, commit encontrado: ${actualCommit}`,
          "O worktree pode ter sido rebased ou resetado; verificar o histórico",
          { expectedBaseCommit, actualCommit },
        )
      }

      return pass("base_commit_match", "Commit base encontrado e válido", { expectedBaseCommit, actualCommit })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(
        "base_commit_match",
        "Commit base não encontrado no repositório",
        `git rev-parse falhou: ${message} — o commit pode ter sido perdido`,
        "Verificar se o repositório principal possui o commit; pode ser necessário restaurar de backup",
        { expectedBaseCommit, error: message.slice(0, 200) },
      )
    }
  }

  /**
   * Verifica se o commit HEAD registrado ainda existe (entregas anteriores).
   * SOMENTE LEITURA: git rev-parse --verify
   */
  private async checkHeadCommitValid(worktreePath: string, expectedHeadCommit: string): Promise<PreflightCheckResult> {
    if (!validCommit(expectedHeadCommit)) {
      return fail(
        "head_commit_valid",
        "Commit HEAD registrado é inválido",
        `Formato inválido: ${expectedHeadCommit}`,
        "Verificar o registro da execução no banco de dados",
        { expectedHeadCommit },
      )
    }

    try {
      const verifyResult = await this.gitRunner.run(
        ["git", "rev-parse", "--verify", `${expectedHeadCommit}^{commit}`],
        worktreePath,
      )
      const actualCommit = verifyResult.stdout.trim()

      if (!actualCommit) {
        return fail(
          "head_commit_valid",
          "Commit HEAD não encontrado no repositório",
          `O commit ${expectedHeadCommit} não existe — entregas anteriores podem ter sido perdidas`,
          "Verificar se o repositório principal possui o commit; pode ser necessário restaurar de backup",
          { expectedHeadCommit },
        )
      }

      return pass("head_commit_valid", "Commit HEAD encontrado", { expectedHeadCommit, actualCommit })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(
        "head_commit_valid",
        "Commit HEAD não encontrado no repositório",
        `git rev-parse falhou: ${message}`,
        "Verificar se o repositório principal possui o commit; pode ser necessário restaurar de backup",
        { expectedHeadCommit, error: message.slice(0, 200) },
      )
    }
  }

  /**
   * Verifica se o projectPath está dentro da raiz do repositório.
   * SOMENTE LEITURA: comparação de caminhos
   */
  private async checkProjectScope(gitRoot: string, repoPath: string, projectPath: string): Promise<PreflightCheckResult> {
    const resolvedGitRoot = resolve(gitRoot)
    const resolvedRepoPath = resolve(repoPath)
    const resolvedProjectPath = resolve(projectPath)

    // repoPath deve estar dentro do gitRoot
    const repoRelative = resolvedRepoPath.startsWith(resolvedGitRoot)
      ? resolvedRepoPath.slice(resolvedGitRoot.length)
      : null
    if (repoRelative === null || repoRelative.startsWith("..")) {
      return fail(
        "project_scope",
        "repoPath está fora da raiz do repositório",
        `repoPath (${resolvedRepoPath}) não está dentro de ${resolvedGitRoot}`,
        "Verificar o repo_path do projeto na configuração",
        { gitRoot: resolvedGitRoot, repoPath: resolvedRepoPath },
      )
    }

    // projectPath deve estar dentro do repoPath (ou ser igual)
    const projectRelative = resolvedProjectPath.startsWith(resolvedRepoPath)
      ? resolvedProjectPath.slice(resolvedRepoPath.length)
      : null
    if (projectRelative === null || (projectRelative !== "" && projectRelative.startsWith(".."))) {
      return fail(
        "project_scope",
        "projectPath está fora do repoPath",
        `projectPath (${resolvedProjectPath}) não está dentro de ${resolvedRepoPath}`,
        "Verificar o projectPath da execução",
        { repoPath: resolvedRepoPath, projectPath: resolvedProjectPath },
      )
    }

    return pass("project_scope", "Escopo do projeto válido", {
      gitRoot: resolvedGitRoot,
      repoPath: resolvedRepoPath,
      projectPath: resolvedProjectPath,
    })
  }

  /**
   * Verifica se as dependências estão presentes (node_modules + package-lock.json).
   * SOMENTE LEITURA: existsSync
   */
  private async checkDependenciesPresent(worktreePath: string): Promise<PreflightCheckResult> {
    const lockFilePath = resolve(worktreePath, "package-lock.json")
    const nodeModulesPath = resolve(worktreePath, "node_modules")
    const packageJsonPath = resolve(worktreePath, "package.json")

    const hasPackageJson = existsSync(packageJsonPath)
    const hasLockFile = existsSync(lockFilePath)
    const hasNodeModules = existsSync(nodeModulesPath)

    if (!hasPackageJson) {
      // Sem package.json = projeto não-Node ou configuração incompleta
      return pass("dependencies_present", "Projeto sem package.json; verificação de dependências não aplicável", {
        hasPackageJson: false,
        hasLockFile,
        hasNodeModules,
      })
    }

    if (!hasLockFile) {
      return fail(
        "dependencies_present",
        "package-lock.json ausente",
        "O worktree possui package.json mas não package-lock.json",
        "Executar 'npm install' para gerar o lockfile antes de retomar",
        { hasPackageJson, hasLockFile, hasNodeModules },
      )
    }

    if (!hasNodeModules) {
      return fail(
        "dependencies_present",
        "node_modules ausente",
        "O worktree possui lockfile mas node_modules não foi instalado",
        "Executar 'npm ci' para instalar dependências antes de retomar",
        { hasPackageJson, hasLockFile, hasNodeModules },
      )
    }

    return pass("dependencies_present", "Dependências presentes", { hasPackageJson, hasLockFile, hasNodeModules })
  }

  /**
   * Verifica se as dependências estão consistentes (npm ci --dry-run ou similar).
   * SOMENTE LEITURA: não instala nada, apenas verifica.
   */
  private async checkDependenciesConsistent(worktreePath: string, timeoutMs: number): Promise<PreflightCheckResult> {
    try {
      // npm ls --all --depth=0 verifica se o tree está consistente sem instalar
      const result = await this.shellRunner.run("npm ls --all --depth=0 --json 2>/dev/null || true", worktreePath, timeoutMs)

      // Se npm ls retornou exit code 0, dependências estão OK
      if (result.exitCode === 0) {
        return pass("dependencies_consistent", "Dependências consistentes", { exitCode: result.exitCode })
      }

      // Exit code != 0 pode indicar dependências faltando ou inconsistentes
      // Mas npm ls pode falhar por outros motivos (peer deps, etc.)
      // Verificamos se há indicação de "MISSING" ou "INVALID" na saída
      const output = result.stdout + result.stderr
      if (output.includes("MISSING") || output.includes("invalid")) {
        return fail(
          "dependencies_consistent",
          "Dependências inconsistentes detectadas",
          "npm ls reportou dependências faltando ou inválidas",
          "Executar 'npm ci' para reinstalar dependências antes de retomar",
          { exitCode: result.exitCode, excerpt: output.slice(0, 300) },
        )
      }

      // Falha não relacionada a dependências — prossegue com aviso
      return pass("dependencies_consistent", "Verificação de consistência inconclusiva (dependências possivelmente OK)", {
        exitCode: result.exitCode,
        note: "npm ls falhou por motivo não relacionado a dependências",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Falha na verificação — não bloqueia a retomada, apenas registra
      return pass("dependencies_consistent", "Verificação de consistência não pôde ser executada", {
        error: message.slice(0, 200),
        note: "A verificação será refeita durante a instalação",
      })
    }
  }

  // ─── Verificações externas (Console e SSH) ─────────────────────────────────

  /**
   * Verifica se o Console OpenClaw está acessível via HTTP.
   * SOMENTE LEITURA: GET /api/agents — não inicia nem substitui sessões.
   * Valida que o Console responde com HTTP 200 e retorna JSON válido.
   */
  private async checkConsoleSession(
    baseUrl: string,
    token: string | undefined,
    timeoutMs: number,
  ): Promise<PreflightCheckResult> {
    const normalizedUrl = baseUrl.replace(/\/$/, "")
    const url = `${normalizedUrl}/api/agents`

    try {
      const headers: Record<string, string> = {
        "Accept": "application/json",
      }
      if (token) {
        headers["Authorization"] = `Bearer ${token}`
      }

      const response = await this.httpRunner.request({
        url,
        method: "GET",
        headers,
        timeoutMs,
      })

      if (response.status === 401 || response.status === 403) {
        return fail(
          "console_session",
          "Console recusou a autenticação",
          `HTTP ${response.status} — token inválido ou expirado`,
          "Verificar OPENCLAW_CONSOLE_TOKEN; o token pode ter sido rotacionado",
          { baseUrl: normalizedUrl, status: response.status },
        )
      }

      if (response.status === 0 || response.status >= 500) {
        return fail(
          "console_session",
          "Console indisponível ou com erro interno",
          `HTTP ${response.status} — Console não respondeu ou falhou internamente`,
          "Verificar se o container do Console está rodando e se a URL está correta",
          { baseUrl: normalizedUrl, status: response.status },
        )
      }

      if (response.status >= 400) {
        return fail(
          "console_session",
          "Console retornou erro HTTP",
          `HTTP ${response.status} — resposta inesperada do Console`,
          "Verificar a versão do Console e compatibilidade da API",
          { baseUrl: normalizedUrl, status: response.status },
        )
      }

      // Valida que o corpo é JSON parseável (mesmo que vazio)
      try {
        JSON.parse(response.body || "{}")
      } catch {
        return fail(
          "console_session",
          "Console retornou resposta inválida",
          "Resposta não é JSON válido — possível proxy ou página de erro",
          "Verificar se a URL aponta para o Console e não para um proxy intermediário",
          { baseUrl: normalizedUrl, status: response.status, bodyPreview: response.body.slice(0, 200) },
        )
      }

      return pass("console_session", "Console acessível e respondendo", {
        baseUrl: normalizedUrl,
        status: response.status,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // Erros de conexão/recusa são os mais comuns
      if (message.includes("ECONNREFUSED") || message.includes("ECONNRESET")) {
        return fail(
          "console_session",
          "Console não está escutando",
          `Conexão recusada: ${message}`,
          "Verificar se o container do Console está rodando (docker ps) e se a porta está correta",
          { baseUrl: normalizedUrl, error: message.slice(0, 200) },
        )
      }

      if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
        return fail(
          "console_session",
          "Host do Console não resolvido",
          `DNS falhou: ${message}`,
          "Verificar OPENCLAW_CONSOLE_URL — hostname inválido ou DNS indisponível",
          { baseUrl: normalizedUrl, error: message.slice(0, 200) },
        )
      }

      if (message.includes("timeout")) {
        return fail(
          "console_session",
          "Console não respondeu dentro do timeout",
          `Timeout após ${timeoutMs}ms: ${message}`,
          "Console pode estar sobrecarregado ou travado; verificar logs do container",
          { baseUrl: normalizedUrl, timeoutMs, error: message.slice(0, 200) },
        )
      }

      return fail(
        "console_session",
        "Falha ao conectar com o Console",
        message,
        "Verificar OPENCLAW_CONSOLE_URL e conectividade de rede",
        { baseUrl: normalizedUrl, error: message.slice(0, 200) },
      )
    }
  }

  /**
   * Verifica conectividade SSH de deploy com identidade estrita do host.
   * SOMENTE LEITURA: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ... true`
   * Não executa nenhum comando remoto além de `true` (exit 0 imediato).
   * Não altera worktree, commits ou estado da tarefa.
   */
  private async checkSshDeploy(
    target: string,
    keyPath: string,
    knownHostsPath: string,
    timeoutMs: number,
  ): Promise<PreflightCheckResult> {
    // target formato: user@host
    const sshArgs = [
      "-i", keyPath,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", `ConnectTimeout=${Math.floor(timeoutMs / 1000)}`,
      target,
      "true",
    ]

    const command = `ssh ${sshArgs.join(" ")}`

    try {
      const result = await this.shellRunner.run(command, "/tmp", timeoutMs)

      if (result.exitCode === 0) {
        return pass("ssh_deploy", "SSH de deploy acessível com identidade estrita", {
          target,
          keyPath,
          knownHostsPath,
        })
      }

      // Analisa stderr para diagnóstico acionável
      const stderr = result.stderr.toLowerCase()

      if (stderr.includes("host key verification failed") || stderr.includes("host key has changed")) {
        return fail(
          "ssh_deploy",
          "Identidade do host SSH alterada",
          "Host key verification failed — a chave do host pode ter sido alterada (MITM ou reinstalação)",
          "Verificar a chave do host em known_hosts; se o host foi reinstalado, atualizar known_hosts manualmente",
          { target, keyPath, knownHostsPath, exitCode: result.exitCode, stderr: result.stderr.slice(0, 300) },
        )
      }

      if (stderr.includes("permission denied") || stderr.includes("publickey")) {
        return fail(
          "ssh_deploy",
          "Autenticação SSH falhou",
          "Permission denied (publickey) — chave privada não aceita ou ausente",
          `Verificar se a chave ${keyPath} existe e está autorizada no host de deploy`,
          { target, keyPath, exitCode: result.exitCode, stderr: result.stderr.slice(0, 300) },
        )
      }

      if (stderr.includes("connection refused") || stderr.includes("no route to host")) {
        return fail(
          "ssh_deploy",
          "Host de deploy inalcançável",
          `Conexão recusada ou sem rota: ${result.stderr.slice(0, 200)}`,
          "Verificar se o host de deploy está ligado e acessível na rede",
          { target, exitCode: result.exitCode, stderr: result.stderr.slice(0, 300) },
        )
      }

      if (stderr.includes("connection timed out") || stderr.includes("timeout")) {
        return fail(
          "ssh_deploy",
          "SSH de deploy não respondeu dentro do timeout",
          `Timeout após ${timeoutMs}ms`,
          "Host pode estar sobrecarregado ou firewall bloqueando; verificar conectividade",
          { target, timeoutMs, exitCode: result.exitCode },
        )
      }

      return fail(
        "ssh_deploy",
        "SSH de deploy falhou",
        `exit code ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
        "Verificar conectividade SSH, chave e known_hosts",
        { target, keyPath, knownHostsPath, exitCode: result.exitCode, stderr: result.stderr.slice(0, 300) },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(
        "ssh_deploy",
        "Falha ao executar verificação SSH",
        message,
        "Verificar se o binário ssh está disponível e se os caminhos da chave/known_hosts estão corretos",
        { target, keyPath, knownHostsPath, error: message.slice(0, 200) },
      )
    }
  }

  // ─── Construção do relatório ────────────────────────────────────────────────

  private buildReport(checks: PreflightCheckResult[], checkedAt: string): ResumePreflightReport {
    const failures = checks.filter((check) => !check.ok)
    const ok = failures.length === 0

    return {
      ok,
      checks,
      failures,
      incidentClassification: ok ? undefined : this.classifyIncident(failures),
      summary: this.buildSummary(checks, failures),
      checkedAt,
    }
  }

  /**
   * Classifica o incidente para agrupamento de falhas sistêmicas.
   * Múltiplas falhas relacionadas são agrupadas em um único incidente.
   */
  private classifyIncident(failures: PreflightCheckResult[]): IncidentClassification {
    if (failures.length === 0) return "git_repository_missing" // não deveria acontecer

    const failureChecks = new Set(failures.map((f) => f.check))

    // Múltiplas falhas de infraestrutura = incidente sistêmico
    if (failures.length >= 3) return "multiple_infrastructure_failures"

    // Falhas de Git
    if (failureChecks.has("git_root")) {
      const gitRootFailure = failures.find((f) => f.check === "git_root")
      if (gitRootFailure?.cause?.includes("corrompido") || gitRootFailure?.cause?.includes("fsck")) {
        return "git_repository_corrupted"
      }
      return "git_repository_missing"
    }

    if (failureChecks.has("git_state")) return "git_repository_corrupted"

    // Falhas de worktree
    if (failureChecks.has("worktree_exists")) return "worktree_missing"

    // Falhas de branch/commit
    if (failureChecks.has("branch_match")) return "branch_diverged"
    if (failureChecks.has("base_commit_match") || failureChecks.has("head_commit_valid")) return "commit_lost"

    // Falhas de escopo
    if (failureChecks.has("project_scope")) return "project_scope_violation"

    // Falhas de dependências
    if (failureChecks.has("dependencies_present")) return "dependencies_missing"
    if (failureChecks.has("dependencies_consistent")) return "dependencies_inconsistent"

    // Falhas de Console (sessão indisponível)
    if (failureChecks.has("console_session")) return "console_unreachable"

    // Falhas de SSH de deploy
    if (failureChecks.has("ssh_deploy")) return "ssh_deploy_unreachable"

    return "multiple_infrastructure_failures"
  }

  private buildSummary(checks: PreflightCheckResult[], failures: PreflightCheckResult[]): string {
    if (failures.length === 0) {
      return `Preflight OK: ${checks.length} verificações passaram com sucesso.`
    }

    const failureDescriptions = failures.map((f) => `[${f.check}] ${f.message}: ${f.cause}`).join("; ")
    return `Preflight FALHOU: ${failures.length}/${checks.length} verificações falharam — ${failureDescriptions}`
  }
}

// ─── Helpers de formatação para histórico ───────────────────────────────────

/**
 * Formata o relatório do preflight para gravação no histórico da tarefa.
 * Inclui motivo original, correção aplicada (sugerida) e quem/qual processo retomou.
 */
export function formatPreflightForHistory(
  report: ResumePreflightReport,
  context: { taskId: string; resumedBy: string; resumedAt?: string },
): string {
  const timestamp = context.resumedAt ?? new Date().toISOString()
  const lines: string[] = [
    `== Preflight de Retomada (${timestamp}) ==`,
    `Tarefa: ${context.taskId}`,
    `Retomado por: ${context.resumedBy}`,
    `Resultado: ${report.ok ? "OK" : "FALHOU"}`,
    `Classificação do incidente: ${report.incidentClassification ?? "(nenhum)"}`,
    "",
  ]

  if (report.ok) {
    lines.push("Todas as verificações passaram:")
    for (const check of report.checks) {
      lines.push(`  ✓ [${check.check}] ${check.message}`)
    }
  } else {
    lines.push("Verificações:")
    for (const check of report.checks) {
      const icon = check.ok ? "✓" : "✗"
      lines.push(`  ${icon} [${check.check}] ${check.message}`)
      if (!check.ok && check.cause) {
        lines.push(`      Causa: ${check.cause}`)
      }
      if (!check.ok && check.suggestedAction) {
        lines.push(`      Ação sugerida: ${check.suggestedAction}`)
      }
    }
  }

  return lines.join("\n")
}
