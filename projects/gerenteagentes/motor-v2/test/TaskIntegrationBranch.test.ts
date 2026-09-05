/**
 * P1 (Alexandre 2026-09-05): arquitetura de branch de integração por tarefa.
 * - ensureTaskIntegration: worktree + branch `motor-v2/<tarefa>/integracao` a
 *   partir da branch raiz; idempotente (reutiliza estado existente).
 * - integrateIntoTaskBranch: merge da subtarefa NA branch da tarefa; conflito
 *   é resultado (merge abortado, nada parcial).
 * - promoteTaskBranch: merge da branch da tarefa na base; conflito → abort +
 *   volta ao estado original (resolução humana).
 * - purgeTaskArtifacts: cobre o worktree de integração (1 nível mais raso).
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { GitWorkspaceManager, taskIntegrationBranch, type GitCommandRunner } from "../src/workspaces/GitWorkspaceManager.js"

const COMMIT = "a".repeat(40)
const MERGE_COMMIT = "b".repeat(40)

function baseRunner(overrides: Partial<Record<string, { stdout?: string } | Error>> = {}) {
  return vi.fn().mockImplementation(async (command: readonly string[], cwd: string) => {
    const key = command.slice(1).join(" ")
    for (const [pattern, value] of Object.entries(overrides)) {
      if (key.includes(pattern) || command.join(" ").includes(pattern)) {
        if (value instanceof Error) throw value
        return { stdout: value?.stdout ?? "", stderr: "" }
      }
    }
    if (key === "status --porcelain") return { stdout: "", stderr: "" }
    if (key === "rev-parse --show-toplevel") return { stdout: "/repo\n", stderr: "" }
    if (key.startsWith("rev-parse")) return { stdout: COMMIT + "\n", stderr: "" }
    if (key.startsWith("diff --name-only")) return { stdout: "", stderr: "" }
    if (key.startsWith("show-ref")) throw new Error("branch inexistente")
    void cwd
    return { stdout: "", stderr: "" }
  })
}

describe("taskIntegrationBranch", () => {
  it("nome evita colisão D/F com as branches de subtarefa", () => {
    expect(taskIntegrationBranch("task-9")).toBe("motor-v2/task-9/integracao")
  })
})

describe("ensureTaskIntegration", () => {
  it("cria worktree + branch da tarefa a partir da branch raiz, sem tocar no checkout principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "motor-v2-taskint-"))
    const runner: GitCommandRunner = { run: baseRunner() }
    try {
      const result = await new GitWorkspaceManager({ root, runner }).ensureTaskIntegration({
        repoPath: "/repo", agentId: "test-agent", rootBaseBranch: "base-desenvolvimento", taskId: "task-9",
      })
      expect(result.branch).toBe("motor-v2/task-9/integracao")
      expect(result.path).toBe(join(root, "test-agent", "worktrees", "task-9", "integracao"))
      expect(result.baseCommit).toBe(COMMIT)
      const calls = vi.mocked(runner.run).mock.calls.map(([command, cwd]) => ({ command, cwd }))
      expect(calls).toContainEqual({ command: ["git", "worktree", "add", "--detach", result.path, COMMIT], cwd: "/repo" })
      expect(calls).toContainEqual({ command: ["git", "switch", "-c", result.branch, COMMIT], cwd: result.path })
      // Repositório principal nunca sofre checkout/switch.
      expect(calls.filter((call) => call.cwd === "/repo").some((call) => call.command[1] === "checkout" || (call.command[1] === "switch" && call.command[2] !== "-c"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reutiliza branch + worktree existentes sem resetar a branch da tarefa", async () => {
    const root = await mkdtemp(join(tmpdir(), "motor-v2-taskint-"))
    const target = join(root, "test-agent", "worktrees", "task-9", "integracao")
    const runner: GitCommandRunner = {
      run: baseRunner({
        "show-ref": { stdout: "" },
        "worktree list": { stdout: `worktree /repo\nworktree ${target}\n` },
      }),
    }
    try {
      const result = await new GitWorkspaceManager({ root, runner }).ensureTaskIntegration({
        repoPath: "/repo", agentId: "test-agent", rootBaseBranch: "base-desenvolvimento", taskId: "task-9",
      })
      expect(result.branch).toBe("motor-v2/task-9/integracao")
      expect(result.path).toBe(target)
      const commands = vi.mocked(runner.run).mock.calls.map(([command]) => command.join(" "))
      expect(commands.some((c) => c.includes("worktree add"))).toBe(false)
      expect(commands.some((c) => c.includes("reset --hard"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("recusa repositório principal sujo na criação nova", async () => {
    const runner: GitCommandRunner = {
      run: baseRunner({ "diff --name-only --ignore-space-at-eol HEAD": { stdout: " M arquivo.ts\n" } }),
    }
    await expect(
      new GitWorkspaceManager({ root: "/tmp/motor-v2-taskint", runner }).ensureTaskIntegration({
        repoPath: "/repo", agentId: "test-agent", rootBaseBranch: "base-desenvolvimento", taskId: "task-9",
      }),
    ).rejects.toThrow("repositório principal não está limpo")
  })
})

describe("integrateIntoTaskBranch", () => {
  it("merge aprovado devolve mergeCommit + preMergeHead", async () => {
    let merged = false
    const run = vi.fn().mockImplementation(async (command: readonly string[]) => {
      const key = command.slice(1).join(" ")
      if (key === "status --porcelain") return { stdout: "", stderr: "" }
      if (key.startsWith("merge")) {
        merged = true
        return { stdout: "", stderr: "" }
      }
      if (key === "rev-parse --verify HEAD") return { stdout: (merged ? MERGE_COMMIT : COMMIT) + "\n", stderr: "" }
      if (key.startsWith("rev-parse")) return { stdout: MERGE_COMMIT + "\n", stderr: "" }
      return { stdout: "", stderr: "" }
    })
    const runner: GitCommandRunner = { run }
    const result = await new GitWorkspaceManager({ root: "/tmp/x", runner }).integrateIntoTaskBranch({
      repoPath: "/repo", taskWorktreePath: "/ws/task", workBranch: "motor-v2/task-9/55/a1", expectedCommit: MERGE_COMMIT,
    })
    expect(result.kind).toBe("merged")
    if (result.kind === "merged") {
      expect(result.mergeCommit).toBe(MERGE_COMMIT)
      expect(result.preMergeHead).toBe(COMMIT)
    }
  })

  it("conflito → aborta o merge (nada parcial) e devolve os arquivos em conflito", async () => {
    const run = vi.fn().mockImplementation(async (command: readonly string[]) => {
      const key = command.slice(1).join(" ")
      if (key === "status --porcelain") return { stdout: "", stderr: "" }
      if (key.startsWith("merge --no-ff")) throw new Error("Automatic merge failed; fix conflicts and then commit the result.")
      if (key.startsWith("merge --abort")) return { stdout: "", stderr: "" }
      if (key.startsWith("diff --name-only --diff-filter=U")) return { stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" }
      if (key === "rev-parse --verify HEAD") return { stdout: COMMIT + "\n", stderr: "" }
      if (key.startsWith("rev-parse")) return { stdout: MERGE_COMMIT + "\n", stderr: "" }
      return { stdout: "", stderr: "" }
    })
    const runner: GitCommandRunner = { run }
    const result = await new GitWorkspaceManager({ root: "/tmp/x", runner }).integrateIntoTaskBranch({
      repoPath: "/repo", taskWorktreePath: "/ws/task", workBranch: "motor-v2/task-9/55/a1", expectedCommit: MERGE_COMMIT,
    })
    expect(result.kind).toBe("conflict")
    if (result.kind === "conflict") expect(result.conflictFiles).toEqual(["src/a.ts", "src/b.ts"])
    const commands = run.mock.calls.map(([command]: [readonly string[]]) => command.join(" "))
    expect(commands).toContain("git merge --abort")
  })
})

describe("promoteTaskBranch", () => {
  it("promoção verde: merge na base + push da base", async () => {
    const calls: string[][] = []
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        calls.push([...command])
        const key = command.slice(1).join(" ")
        if (key === "symbolic-ref --quiet --short HEAD") return { stdout: "outra-branch\n", stderr: "" }
        if (key === "rev-parse --verify HEAD") return { stdout: MERGE_COMMIT + "\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    }
    const result = await new GitWorkspaceManager({ root: "/tmp/x", runner }).promoteTaskBranch({
      repoPath: "/repo", baseBranch: "base-desenvolvimento", taskBranch: "motor-v2/task-9/integracao",
    })
    expect(result.kind).toBe("promoted")
    expect(calls).toContainEqual(["git", "switch", "base-desenvolvimento"])
    expect(calls).toContainEqual(["git", "merge", "--no-ff", "--no-edit", "motor-v2/task-9/integracao"])
    expect(calls).toContainEqual(["git", "push", "origin", "base-desenvolvimento"])
  })

  it("conflito com a base → abort + volta à branch original; nada é aplicado", async () => {
    const calls: string[][] = []
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        calls.push([...command])
        const key = command.slice(1).join(" ")
        if (key === "symbolic-ref --quiet --short HEAD") return { stdout: "outra-branch\n", stderr: "" }
        if (key.startsWith("merge --no-ff")) throw new Error("CONFLICT (content): Merge conflict in src/x.ts")
        if (key.startsWith("diff --name-only --diff-filter=U")) return { stdout: "src/x.ts\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    }
    const result = await new GitWorkspaceManager({ root: "/tmp/x", runner }).promoteTaskBranch({
      repoPath: "/repo", baseBranch: "base-desenvolvimento", taskBranch: "motor-v2/task-9/integracao",
    })
    expect(result.kind).toBe("conflict")
    if (result.kind === "conflict") expect(result.conflictFiles).toEqual(["src/x.ts"])
    expect(calls).toContainEqual(["git", "merge", "--abort"])
    expect(calls).toContainEqual(["git", "switch", "outra-branch"])
    expect(calls.some((call) => call[1] === "push")).toBe(false)
  })
})

describe("purgeTaskArtifacts com worktree de integração", () => {
  it("remove worktree integracao e de subtarefa sem varrer a raiz worktrees/", async () => {
    const root = await mkdtemp(join(tmpdir(), "motor-v2-purge-"))
    const ws = join(root, "agent")
    const integracao = join(ws, "worktrees", "task-9", "integracao")
    const subtaskWt = join(ws, "worktrees", "task-9", "55", "a1")
    const removedDirs: string[] = []
    const runner: GitCommandRunner = {
      run: vi.fn().mockImplementation(async (command: readonly string[]) => {
        const key = command.slice(1).join(" ")
        if (key === "worktree list --porcelain") return { stdout: `worktree /repo\nworktree ${integracao}\nworktree ${subtaskWt}\n`, stderr: "" }
        if (key.startsWith("worktree remove")) {
          removedDirs.push(command[4] ?? "")
          return { stdout: "", stderr: "" }
        }
        if (key.startsWith("branch --list")) return { stdout: "  motor-v2/task-9/integracao\n  motor-v2/task-9/55/a1\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    }
    try {
      const result = await new GitWorkspaceManager({ root, runner }).purgeTaskArtifacts({ repoPath: "/repo", taskId: "task-9" })
      expect(result.worktreesRemoved).toBe(2)
      expect(result.branchesRemoved).toBe(2)
      expect(removedDirs.sort()).toEqual([integracao, subtaskWt].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
