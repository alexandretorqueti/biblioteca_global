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
})
