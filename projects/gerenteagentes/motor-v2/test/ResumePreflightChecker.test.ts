/**
 * Testes do ResumePreflightChecker
 * @vitest-environment node
 *
 * Testa as verificações locais somente-leitura do preflight de retomada:
 * - Verificação de raiz Git
 * - Verificação de estado Git
 * - Verificação de worktree
 * - Verificação de branch esperada
 * - Verificação de commit registrado
 * - Verificação de dependências
 * - Agrupamento de falhas sistêmicas
 * - Formatação para histórico
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ResumePreflightChecker,
  formatPreflightForHistory,
  type PreflightGitCommandRunner,
  type PreflightShellCommandRunner,
} from "../src/workspaces/ResumePreflightChecker.js"

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "motor-v2-preflight-"))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/**
 * Cria um mock de GitCommandRunner que responde baseado em padrões dos argumentos.
 * O gitRoot é usado para simular a saída de --show-toplevel.
 */
function createMockGitRunner(options: {
  gitRoot?: string
  branch?: string
  revParseOutput?: string
  statusError?: Error
  revParseError?: Error
} = {}): PreflightGitCommandRunner {
  const gitRoot = options.gitRoot ?? "/repo/principal"
  return {
    run: vi.fn().mockImplementation(async (command: readonly string[], _cwd: string) => {
      const cmdStr = command.join(" ")

      if (cmdStr.includes("--show-toplevel")) {
        return { stdout: gitRoot + "\n", stderr: "" }
      }
      if (cmdStr.includes("status") && cmdStr.includes("--porcelain")) {
        if (options.statusError) throw options.statusError
        return { stdout: "", stderr: "" }
      }
      if (cmdStr.includes("branch") && cmdStr.includes("--show-current")) {
        return { stdout: (options.branch ?? "motor-v2/task-7/13/a1") + "\n", stderr: "" }
      }
      if (cmdStr.includes("rev-parse")) {
        if (options.revParseError) throw options.revParseError
        return { stdout: (options.revParseOutput ?? "a".repeat(40)) + "\n", stderr: "" }
      }
      return { stdout: "", stderr: "" }
    }),
  }
}

function createMockShellRunner(exitCode = 0, stdout = "", stderr = ""): PreflightShellCommandRunner {
  return {
    run: vi.fn().mockResolvedValue({ stdout, stderr, exitCode }),
  }
}

// ─── Verificação de raiz Git ────────────────────────────────────────────────

describe("ResumePreflightChecker — verificação de raiz Git", () => {
  it("passa quando o repositório existe e é válido", async () => {
    // Cria um diretório real para o teste
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })

    const runner = createMockGitRunner({ gitRoot: repoPath })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({ repoPath })

    const gitRootCheck = report.checks.find((c) => c.check === "git_root")
    expect(gitRootCheck).toBeDefined()
    expect(gitRootCheck!.ok).toBe(true)
    expect(gitRootCheck!.details?.gitRoot).toBe(repoPath)
  })

  it("falha quando o caminho não é absoluto", async () => {
    const checker = new ResumePreflightChecker({ gitRunner: createMockGitRunner() })

    const report = await checker.check({ repoPath: "relative/path" })

    const gitRootCheck = report.checks.find((c) => c.check === "git_root")
    expect(gitRootCheck!.ok).toBe(false)
    expect(gitRootCheck!.cause).toContain("absoluto")
    expect(report.incidentClassification).toBe("git_repository_missing")
  })

  it("falha quando o repositório não existe", async () => {
    const checker = new ResumePreflightChecker({ gitRunner: createMockGitRunner() })

    const report = await checker.check({ repoPath: "/nonexistent/path" })

    const gitRootCheck = report.checks.find((c) => c.check === "git_root")
    expect(gitRootCheck!.ok).toBe(false)
    expect(gitRootCheck!.cause).toContain("não existe")
    expect(report.incidentClassification).toBe("git_repository_missing")
  })

  it("falha quando git rev-parse falha (repositório corrompido)", async () => {
    const repoPath = join(tempDir, "corrupt-repo")
    await mkdir(repoPath, { recursive: true })

    // Mock que falha especificamente no --show-toplevel
    const runner: PreflightGitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        const cmdStr = command.join(" ")
        if (cmdStr.includes("--show-toplevel")) {
          throw new Error("not a git repository")
        }
        return { stdout: "", stderr: "" }
      }),
    }
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({ repoPath })

    const gitRootCheck = report.checks.find((c) => c.check === "git_root")
    expect(gitRootCheck!.ok).toBe(false)
    expect(gitRootCheck!.cause).toContain("not a git repository")
  })

  it("interrompe verificações subsequentes se git_root falhar", async () => {
    const checker = new ResumePreflightChecker({ gitRunner: createMockGitRunner() })

    const report = await checker.check({
      repoPath: "/nonexistent/path",
      worktreePath: "/some/worktree",
      expectedBranch: "motor-v2/task-7/13/a1",
    })

    // Apenas git_root deve estar presente (demais puladas)
    expect(report.checks.length).toBe(1)
    expect(report.checks[0]!.check).toBe("git_root")
    expect(report.ok).toBe(false)
  })
})

// ─── Verificação de estado Git ──────────────────────────────────────────────

describe("ResumePreflightChecker — verificação de estado Git", () => {
  it("passa quando git status funciona (repositório íntegro)", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })

    const runner = createMockGitRunner({ gitRoot: repoPath })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({ repoPath })

    const gitStateCheck = report.checks.find((c) => c.check === "git_state")
    expect(gitStateCheck).toBeDefined()
    expect(gitStateCheck!.ok).toBe(true)
  })

  it("falha quando git status falha (repositório corrompido)", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })

    const runner = createMockGitRunner({
      gitRoot: repoPath,
      statusError: new Error("fatal: not a git repository"),
    })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({ repoPath })

    const gitStateCheck = report.checks.find((c) => c.check === "git_state")
    expect(gitStateCheck!.ok).toBe(false)
    expect(gitStateCheck!.cause).toContain("git status falhou")
    expect(report.incidentClassification).toBe("git_repository_corrupted")
  })
})

// ─── Verificação de worktree ────────────────────────────────────────────────

describe("ResumePreflightChecker — verificação de worktree", () => {
  it("passa quando o worktree existe", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })

    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
    })
    const report = await checker.check({ repoPath, worktreePath })

    const worktreeCheck = report.checks.find((c) => c.check === "worktree_exists")
    expect(worktreeCheck).toBeDefined()
    expect(worktreeCheck!.ok).toBe(true)
  })

  it("falha quando o worktree não existe", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })

    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
    })
    const report = await checker.check({
      repoPath,
      worktreePath: "/nonexistent/worktree",
    })

    const worktreeCheck = report.checks.find((c) => c.check === "worktree_exists")
    expect(worktreeCheck).toBeDefined()
    expect(worktreeCheck!.ok).toBe(false)
    expect(worktreeCheck!.cause).toContain("não existe")
    expect(report.incidentClassification).toBe("worktree_missing")
  })

  it("falha quando o caminho não é absoluto", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })

    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
    })
    const report = await checker.check({
      repoPath,
      worktreePath: "relative/worktree",
    })

    const worktreeCheck = report.checks.find((c) => c.check === "worktree_exists")
    expect(worktreeCheck).toBeDefined()
    expect(worktreeCheck!.ok).toBe(false)
    expect(worktreeCheck!.cause).toContain("absoluto")
  })
})

// ─── Verificação de branch ──────────────────────────────────────────────────

describe("ResumePreflightChecker — verificação de branch", () => {
  it("passa quando a branch corresponde à esperada", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })

    const runner = createMockGitRunner({
      gitRoot: repoPath,
      branch: "motor-v2/task-7/13/a1",
    })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({
      repoPath,
      worktreePath,
      expectedBranch: "motor-v2/task-7/13/a1",
    })

    const branchCheck = report.checks.find((c) => c.check === "branch_match")
    expect(branchCheck).toBeDefined()
    expect(branchCheck!.ok).toBe(true)
    expect(branchCheck!.details?.expectedBranch).toBe("motor-v2/task-7/13/a1")
    expect(branchCheck!.details?.actualBranch).toBe("motor-v2/task-7/13/a1")
  })

  it("falha quando a branch diverge da esperada", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })

    const runner = createMockGitRunner({
      gitRoot: repoPath,
      branch: "motor-v2/task-7/13/a2",
    })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({
      repoPath,
      worktreePath,
      expectedBranch: "motor-v2/task-7/13/a1",
    })

    const branchCheck = report.checks.find((c) => c.check === "branch_match")
    expect(branchCheck).toBeDefined()
    expect(branchCheck!.ok).toBe(false)
    expect(branchCheck!.cause).toContain("Branch esperada")
    expect(report.incidentClassification).toBe("branch_diverged")
  })

  it("falha quando worktree está em detached HEAD", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })

    const runner = createMockGitRunner({
      gitRoot: repoPath,
      branch: "",
    })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({
      repoPath,
      worktreePath,
      expectedBranch: "motor-v2/task-7/13/a1",
    })

    const branchCheck = report.checks.find((c) => c.check === "branch_match")
    expect(branchCheck).toBeDefined()
    expect(branchCheck!.ok).toBe(false)
    expect(branchCheck!.cause).toContain("vazio")
  })
})

// ─── Verificação de commit ──────────────────────────────────────────────────

describe("ResumePreflightChecker — verificação de commit", () => {
  it("passa quando o commit base existe e corresponde", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })

    const expectedCommit = "a".repeat(40)
    const runner = createMockGitRunner({
      gitRoot: repoPath,
      revParseOutput: expectedCommit,
    })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({
      repoPath,
      worktreePath,
      expectedBaseCommit: expectedCommit,
    })

    const commitCheck = report.checks.find((c) => c.check === "base_commit_match")
    expect(commitCheck).toBeDefined()
    expect(commitCheck!.ok).toBe(true)
  })

  it("falha quando o commit base não existe", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })

    const runner = createMockGitRunner({
      gitRoot: repoPath,
      revParseError: new Error("fatal: Not a valid object name"),
    })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({
      repoPath,
      worktreePath,
      expectedBaseCommit: "b".repeat(40),
    })

    const commitCheck = report.checks.find((c) => c.check === "base_commit_match")
    expect(commitCheck).toBeDefined()
    expect(commitCheck!.ok).toBe(false)
    expect(commitCheck!.cause).toContain("git rev-parse falhou")
    expect(report.incidentClassification).toBe("commit_lost")
  })

  it("falha quando o formato do commit é inválido", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })

    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
    })

    const report = await checker.check({
      repoPath,
      worktreePath,
      expectedBaseCommit: "not-a-valid-commit",
    })

    const commitCheck = report.checks.find((c) => c.check === "base_commit_match")
    expect(commitCheck).toBeDefined()
    expect(commitCheck!.ok).toBe(false)
    expect(commitCheck!.cause).toContain("inválido")
  })
})

// ─── Verificação de escopo ──────────────────────────────────────────────────

describe("ResumePreflightChecker — verificação de escopo do projeto", () => {
  it("passa quando projectPath está dentro do repoPath", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })

    const runner = createMockGitRunner({ gitRoot: repoPath })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({
      repoPath,
      projectPath: join(repoPath, "projects/gerenteagentes"),
    })

    const scopeCheck = report.checks.find((c) => c.check === "project_scope")
    expect(scopeCheck).toBeDefined()
    expect(scopeCheck!.ok).toBe(true)
  })

  it("falha quando repoPath está fora da raiz Git", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const otherPath = join(tempDir, "other")
    await mkdir(otherPath, { recursive: true })

    const runner = createMockGitRunner({ gitRoot: otherPath })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    const report = await checker.check({
      repoPath,
      projectPath: join(repoPath, "projects/gerenteagentes"),
    })

    const scopeCheck = report.checks.find((c) => c.check === "project_scope")
    expect(scopeCheck).toBeDefined()
    expect(scopeCheck!.ok).toBe(false)
    expect(scopeCheck!.cause).toContain("não está dentro de")
    expect(report.incidentClassification).toBe("project_scope_violation")
  })
})

// ─── Verificação de dependências ────────────────────────────────────────────

describe("ResumePreflightChecker — verificação de dependências", () => {
  it("passa quando package-lock.json e node_modules existem", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, "package.json"), "{}")
    await writeFile(join(worktreePath, "package-lock.json"), "{}")
    await mkdir(join(worktreePath, "node_modules"), { recursive: true })

    const shellRunner = createMockShellRunner(0, '{"name":"test"}')
    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
      shellRunner,
    })

    const report = await checker.check({
      repoPath,
      worktreePath,
      checkDependencies: true,
    })

    const depsCheck = report.checks.find((c) => c.check === "dependencies_present")
    expect(depsCheck).toBeDefined()
    expect(depsCheck!.ok).toBe(true)
  })

  it("falha quando package-lock.json está ausente", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, "package.json"), "{}")
    // Sem package-lock.json

    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
      shellRunner: createMockShellRunner(),
    })

    const report = await checker.check({
      repoPath,
      worktreePath,
      checkDependencies: true,
    })

    const depsCheck = report.checks.find((c) => c.check === "dependencies_present")
    expect(depsCheck).toBeDefined()
    expect(depsCheck!.ok).toBe(false)
    expect(depsCheck!.cause).toContain("package-lock.json")
    expect(report.incidentClassification).toBe("dependencies_missing")
  })

  it("falha quando node_modules está ausente", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, "package.json"), "{}")
    await writeFile(join(worktreePath, "package-lock.json"), "{}")
    // Sem node_modules

    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
      shellRunner: createMockShellRunner(),
    })

    const report = await checker.check({
      repoPath,
      worktreePath,
      checkDependencies: true,
    })

    const depsCheck = report.checks.find((c) => c.check === "dependencies_present")
    expect(depsCheck).toBeDefined()
    expect(depsCheck!.ok).toBe(false)
    expect(depsCheck!.cause).toContain("node_modules")
  })

  it("passa (não aplicável) quando não há package.json", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })
    // Sem package.json

    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
      shellRunner: createMockShellRunner(),
    })

    const report = await checker.check({
      repoPath,
      worktreePath,
      checkDependencies: true,
    })

    const depsCheck = report.checks.find((c) => c.check === "dependencies_present")
    expect(depsCheck).toBeDefined()
    expect(depsCheck!.ok).toBe(true)
    expect(depsCheck!.message).toContain("não aplicável")
  })

  it("detecta dependências inconsistentes", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, "package.json"), "{}")
    await writeFile(join(worktreePath, "package-lock.json"), "{}")
    await mkdir(join(worktreePath, "node_modules"), { recursive: true })

    const shellRunner = createMockShellRunner(1, '{"error":"MISSING"}', "")
    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
      shellRunner,
    })

    const report = await checker.check({
      repoPath,
      worktreePath,
      checkDependencies: true,
    })

    const consistentCheck = report.checks.find((c) => c.check === "dependencies_consistent")
    expect(consistentCheck).toBeDefined()
    expect(consistentCheck!.ok).toBe(false)
    expect(consistentCheck!.cause).toContain("dependências")
    expect(report.incidentClassification).toBe("dependencies_inconsistent")
  })
})

// ─── Agrupamento de falhas sistêmicas ───────────────────────────────────────

describe("ResumePreflightChecker — agrupamento de falhas sistêmicas", () => {
  it("classifica como múltiplas falhas quando há 3+ verificações falhando", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(worktreePath, "package.json"), "{}")
    // Sem package-lock.json, sem node_modules

    const runner = createMockGitRunner({
      gitRoot: repoPath,
      branch: "wrong-branch",
      revParseError: new Error("commit not found"),
    })
    const checker = new ResumePreflightChecker({
      gitRunner: runner,
      shellRunner: createMockShellRunner(),
    })

    const report = await checker.check({
      repoPath,
      worktreePath,
      expectedBranch: "motor-v2/task-7/13/a1",
      expectedBaseCommit: "a".repeat(40),
      checkDependencies: true,
    })

    expect(report.failures.length).toBeGreaterThanOrEqual(3)
    expect(report.incidentClassification).toBe("multiple_infrastructure_failures")
  })
})

// ─── Resumo e formatação ────────────────────────────────────────────────────

describe("ResumePreflightChecker — resumo e formatação", () => {
  it("gera resumo OK quando todas as verificações passam", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })

    const checker = new ResumePreflightChecker({
      gitRunner: createMockGitRunner({ gitRoot: repoPath }),
    })

    const report = await checker.check({ repoPath })

    expect(report.ok).toBe(true)
    expect(report.summary).toContain("OK")
    expect(report.summary).toContain("passaram com sucesso")
  })

  it("gera resumo com falhas detalhadas", async () => {
    const checker = new ResumePreflightChecker({ gitRunner: createMockGitRunner() })

    const report = await checker.check({ repoPath: "/nonexistent/path" })

    expect(report.ok).toBe(false)
    expect(report.summary).toContain("FALHOU")
    expect(report.summary).toContain("git_root")
  })

  it("formatPreflightForHistory inclui todas as informações", () => {
    const report = {
      ok: false,
      checks: [
        { check: "git_root" as const, ok: true, message: "Repositório encontrado" },
        { check: "branch_match" as const, ok: false, message: "Branch diverge", cause: "Esperada: a, encontrada: b", suggestedAction: "Verificar worktree" },
      ],
      failures: [
        { check: "branch_match" as const, ok: false, message: "Branch diverge", cause: "Esperada: a, encontrada: b", suggestedAction: "Verificar worktree" },
      ],
      incidentClassification: "branch_diverged" as const,
      summary: "Preflight FALHOU",
      checkedAt: "2026-09-08T12:00:00.000Z",
    }

    const formatted = formatPreflightForHistory(report, {
      taskId: "task-7",
      resumedBy: "motor-v2/recover",
    })

    expect(formatted).toContain("task-7")
    expect(formatted).toContain("motor-v2/recover")
    expect(formatted).toContain("branch_diverged")
    expect(formatted).toContain("Branch diverge")
    expect(formatted).toContain("Verificar worktree")
  })
})

// ─── Somente leitura (sem alterações) ───────────────────────────────────────

describe("ResumePreflightChecker — garantia de somente leitura", () => {
  it("não executa comandos que alteram o workspace", async () => {
    const repoPath = join(tempDir, "repo")
    await mkdir(repoPath, { recursive: true })
    const worktreePath = join(tempDir, "worktree")
    await mkdir(worktreePath, { recursive: true })

    const runner = createMockGitRunner({ gitRoot: repoPath })
    const checker = new ResumePreflightChecker({ gitRunner: runner })

    await checker.check({
      repoPath,
      worktreePath,
      expectedBranch: "motor-v2/task-7/13/a1",
      expectedBaseCommit: "a".repeat(40),
      checkDependencies: true,
    })

    const calls = vi.mocked(runner.run).mock.calls.map(([cmd]) => cmd.join(" "))

    // Nenhum comando de escrita deve ser executado
    const writeCommands = ["checkout", "switch", "merge", "reset", "clean", "worktree add", "worktree remove", "branch -D", "branch -d"]
    for (const writeCmd of writeCommands) {
      const found = calls.some((call) => call.includes(writeCmd))
      expect(found).toBe(false)
    }
  })
})
