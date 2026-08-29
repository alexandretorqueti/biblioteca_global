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
        if (command[1] === "rev-parse") return { stdout: "a".repeat(40) + "\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    }
    try {
      const result = await new GitWorkspaceManager({ root, runner }).prepare({
        repoPath: "/repo/principal", baseBranch: "base-desenvolvimento", taskId: "task-7", subtaskId: "13", attempt: 1,
      })
      expect(result.branch).toBe("motor-v2/task-7/13/a1")
      expect(result.path).toBe(join(root, "task-7", "13", "a1"))
      const calls = vi.mocked(runner.run).mock.calls.map(([command, cwd]) => ({ command, cwd }))
      expect(calls).toContainEqual({ command: ["git", "worktree", "add", "--detach", result.path, "a".repeat(40)], cwd: "/repo/principal" })
      expect(calls).toContainEqual({ command: ["git", "switch", "-c", result.branch, "a".repeat(40)], cwd: result.path })
      expect(calls.filter((call) => call.cwd === "/repo/principal").some((call) => call.command[1] === "checkout" || call.command[1] === "switch")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("recusa repositório principal sujo antes de criar worktree", async () => {
    const runner: GitCommandRunner = { run: vi.fn().mockResolvedValue({ stdout: " M arquivo.ts\n", stderr: "" }) }
    await expect(new GitWorkspaceManager({ root: "/tmp/motor-v2-workspaces", runner }).prepare({
      repoPath: "/repo/principal", baseBranch: "base", taskId: "7", subtaskId: "8", attempt: 1,
    })).rejects.toThrow("repositório principal não está limpo")
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
})
