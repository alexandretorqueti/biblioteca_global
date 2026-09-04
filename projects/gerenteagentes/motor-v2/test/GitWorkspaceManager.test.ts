import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { GitWorkspaceManager, type GitCommandRunner } from "../src/workspaces/GitWorkspaceManager.js"

describe("GitWorkspaceManager", () => {
  it("cria worktree e branch exclusivos sem checkout no repositório principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "motor-v2-workspaces-"))
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        if (command[1] === "status") return { stdout: "", stderr: "" }
        if (command[1] === "rev-parse" && command[2] === "--show-toplevel") return { stdout: "/repo/principal\n", stderr: "" }
        if (command[1] === "rev-parse") return { stdout: "a".repeat(40) + "\n", stderr: "" }
        if (command[1] === "show-ref") throw new Error("branch inexistente")
        return { stdout: "", stderr: "" }
      }),
    }
    try {
      const result = await new GitWorkspaceManager({ root, runner }).prepare({
        repoPath: "/repo/principal", agentId: "test-agent", baseBranch: "base-desenvolvimento", taskId: "task-7", subtaskId: "13", attempt: 1,
      })
      expect(result.branch).toBe("motor-v2/task-7/13/a1")
      expect(result.path).toBe(join(root, "test-agent", "worktrees", "task-7", "13", "a1"))
      expect(result.projectPath).toBe(result.path)
      const calls = vi.mocked(runner.run).mock.calls.map(([command, cwd]) => ({ command, cwd }))
      expect(calls).toContainEqual({ command: ["git", "worktree", "add", "--detach", result.path, "a".repeat(40)], cwd: "/repo/principal" })
      expect(calls).toContainEqual({ command: ["git", "switch", "-c", result.branch, "a".repeat(40)], cwd: result.path })
      expect(calls.filter((call) => call.cwd === "/repo/principal").some((call) => call.command[1] === "checkout" || call.command[1] === "switch")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reutiliza branch existente após worktree prunable, sem switch -c", async () => {
    const root = await mkdtemp(join(tmpdir(), "motor-v2-workspaces-"))
    const branch = "motor-v2/task-7/13/a1"
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        if (command[1] === "rev-parse" && command[2] === "--show-toplevel") return { stdout: "/repo/principal\n", stderr: "" }
        if (command[1] === "rev-parse") return { stdout: "a".repeat(40) + "\n", stderr: "" }
        if (command[1] === "show-ref") return { stdout: "", stderr: "" }
        if (command[1] === "worktree" && command[2] === "list") return { stdout: "worktree /repo/principal\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    }
    try {
      const result = await new GitWorkspaceManager({ root, runner }).prepare({
        repoPath: "/repo/principal", agentId: "test-agent", baseBranch: "base-desenvolvimento", taskId: "task-7", subtaskId: "13", attempt: 1,
      })
      expect(result.branch).toBe(branch)
      const commands = vi.mocked(runner.run).mock.calls.map(([command]) => command)
      expect(commands).toContainEqual(["git", "worktree", "add", result.path, branch])
      expect(commands).not.toContainEqual(["git", "switch", "-c", branch, "a".repeat(40)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("preserva o subdiretório do projeto para executar gates em worktree de monorepo", async () => {
    const root = await mkdtemp(join(tmpdir(), "motor-v2-workspaces-"))
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        if (command[1] === "rev-parse" && command[2] === "--show-toplevel") return { stdout: "/repo\n", stderr: "" }
        if (command[1] === "rev-parse") return { stdout: "a".repeat(40) + "\n", stderr: "" }
        if (command[1] === "show-ref") throw new Error("branch inexistente")
        return { stdout: "", stderr: "" }
      }),
    }
    try {
      const result = await new GitWorkspaceManager({ root, runner }).prepare({
        repoPath: "/repo/projects/gerenteagentes", agentId: "test-agent", baseBranch: "base-desenvolvimento", taskId: "task-7", subtaskId: "13", attempt: 1,
      })
      expect(result.projectPath).toBe(join(result.path, "projects", "gerenteagentes"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("recusa repositório principal sujo antes de criar worktree", async () => {
    const runner: GitCommandRunner = { run: vi.fn().mockResolvedValue({ stdout: " M arquivo.ts\n", stderr: "" }) }
    await expect(new GitWorkspaceManager({ root: "/tmp/motor-v2-workspaces", runner }).prepare({
      repoPath: "/repo/principal", agentId: "test-agent", baseBranch: "base", taskId: "7", subtaskId: "8", attempt: 1,
    })).rejects.toThrow("repositório principal não está limpo")
  })

  it("classifica repositório ausente (ENOENT) como bloqueio ambiental", async () => {
    const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        // ENOENT ocorre no spawn do git (binário ausente) — qualquer comando falha
        if (command[1] === "status" || command[1] === "diff") throw enoent
        return { stdout: "", stderr: "" }
      }),
    }
    await expect(new GitWorkspaceManager({ root: "/tmp/motor-v2-workspaces", runner }).prepare({
      repoPath: "/repo/inexistente", agentId: "test-agent", baseBranch: "base", taskId: "7", subtaskId: "8", attempt: 1,
    })).rejects.toThrow("Ambiente bloqueado: repositório não encontrado: /repo/inexistente")
  })

  it("lista os arquivos alterados entre base e commit da correção", async () => {
    const runner: GitCommandRunner = { run: vi.fn().mockResolvedValue({ stdout: "src/a.test.ts\ntests/b.ts\n", stderr: "" }) }
    const manager = new GitWorkspaceManager({ root: "/tmp/motor-v2-workspaces", runner })
    await expect(manager.changedPaths("/tmp/worktree", "a".repeat(40), "b".repeat(40))).resolves.toEqual(["src/a.test.ts", "tests/b.ts"])
  })

  it("integra somente o commit aprovado na branch-base", async () => {
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        if (command[1] === "status") return { stdout: "", stderr: "" }
        if (command[1] === "rev-parse" && command[3] === "motor-v2/task-7/13/a1^{commit}") return { stdout: "a".repeat(40) + "\n", stderr: "" }
        if (command[1] === "symbolic-ref") return { stdout: "base-desenvolvimento\n", stderr: "" }
        if (command[1] === "rev-parse") return { stdout: "b".repeat(40) + "\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    }
    const manager = new GitWorkspaceManager({ root: "/tmp/motor-v2-workspaces", runner })
    const result = await manager.integrate({
      repoPath: "/repo/principal",
      baseBranch: "base-desenvolvimento",
      workBranch: "motor-v2/task-7/13/a1",
      expectedCommit: "a".repeat(40),
    })

    expect(result.mergeCommit).toBe("b".repeat(40))
    expect(vi.mocked(runner.run).mock.calls.map(([command]) => command)).toContainEqual([
      "git", "merge", "--no-ff", "--no-edit", "motor-v2/task-7/13/a1",
    ])
    expect(vi.mocked(runner.run).mock.calls.map(([command]) => command)).toContainEqual([
      "git", "push", "origin", "base-desenvolvimento",
    ])
  })

  it("aborta o merge quando há conflito", async () => {
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        if (command[1] === "status") return { stdout: "", stderr: "" }
        if (command[1] === "rev-parse" && command[3]?.includes("^{commit}")) return { stdout: "a".repeat(40) + "\n", stderr: "" }
        if (command[1] === "symbolic-ref") return { stdout: "feature\n", stderr: "" }
        if (command[1] === "merge") throw new Error("CONFLICT")
        return { stdout: "", stderr: "" }
      }),
    }
    const manager = new GitWorkspaceManager({ root: "/tmp/motor-v2-workspaces", runner })

    await expect(manager.integrate({
      repoPath: "/repo/principal", baseBranch: "base", workBranch: "feature", expectedCommit: "a".repeat(40),
    })).rejects.toThrow("Integração Git falhou: CONFLICT")
    expect(vi.mocked(runner.run).mock.calls.map(([command]) => command)).toContainEqual(["git", "merge", "--abort"])
    expect(vi.mocked(runner.run).mock.calls.map(([command]) => command)).toContainEqual(["git", "switch", "feature"])
  })

  it("remove somente o worktree temporário dentro da raiz segura", async () => {
    const root = await mkdtemp(join(tmpdir(), "motor-v2-workspaces-"))
    const workspacePath = join(root, "task-7", "13", "a1")
    const runner: GitCommandRunner = { run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }) }
    try {
      await new GitWorkspaceManager({ root, runner }).cleanup({ repoPath: "/repo/principal", workspacePath })
      expect(vi.mocked(runner.run)).toHaveBeenCalledWith(
        ["git", "worktree", "remove", "--force", workspacePath],
        "/repo/principal",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("recusa limpar um caminho fora da raiz segura", async () => {
    const runner: GitCommandRunner = { run: vi.fn() }
    await expect(new GitWorkspaceManager({ root: "/tmp/motor-v2-workspaces", runner }).cleanup({
      repoPath: "/repo/principal",
      workspacePath: "/tmp/outro-workspace",
    })).rejects.toThrow("workspace fora da raiz segura")
    expect(runner.run).not.toHaveBeenCalled()
  })

  it("purgeTaskArtifacts remove worktrees e branches residuais de tarefa finalizada", async () => {
    const root = await mkdtemp(join(tmpdir(), "motor-v2-workspaces-"))
    const wt1 = join(root, "task-99", "1", "a1")
    const wt2 = join(root, "task-99", "1", "a2")
    const wtOutro = join(root, "task-50", "2", "a1")
    const branchesRemoved: string[] = []
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        if (command[1] === "worktree" && command[2] === "list") {
          return {
            stdout: [
              `worktree /repo/principal`,
              `HEAD abc123`,
              ``,
              `worktree ${wt1}`,
              `HEAD def456`,
              ``,
              `worktree ${wt2}`,
              `HEAD ghi789`,
              ``,
              `worktree ${wtOutro}`,
              `HEAD jkl012`,
              ``,
            ].join("\n"),
            stderr: "",
          }
        }
        if (command[1] === "worktree" && command[2] === "remove") return { stdout: "", stderr: "" }
        if (command[1] === "branch" && command[2] === "--list") {
          return { stdout: "  motor-v2/task-99/1/a1\n  motor-v2/task-99/1/a2\n", stderr: "" }
        }
        if (command[1] === "branch" && command[2] === "-D") {
          branchesRemoved.push(command[3] as string)
          return { stdout: "", stderr: "" }
        }
        return { stdout: "", stderr: "" }
      }),
    }
    try {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(wt1, { recursive: true })
      await mkdir(wt2, { recursive: true })
      await mkdir(wtOutro, { recursive: true })

      const result = await new GitWorkspaceManager({ root, runner }).purgeTaskArtifacts({
        repoPath: "/repo/principal",
        taskId: "task-99",
      })
      expect(result.worktreesRemoved).toBe(2)
      expect(result.branchesRemoved).toBe(2)
      expect(branchesRemoved).toContain("motor-v2/task-99/1/a1")
      expect(branchesRemoved).toContain("motor-v2/task-99/1/a2")
      // Worktree de outra tarefa NÃO deve ser removido
      const calls = vi.mocked(runner.run).mock.calls
      const removedPaths = calls.filter(([c]) => c[1] === "worktree" && c[2] === "remove").map(([c]) => c[4])
      expect(removedPaths).not.toContain(wtOutro)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
