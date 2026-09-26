import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PromotionConflictEvidenceCollector } from "../src/promotion-conflicts/PromotionConflictEvidenceCollector.js"

const roots: string[] = []
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("PromotionConflictEvidenceCollector", () => {
  it("simula conflito em worktree descartável sem alterar a base", async () => {
    const repo = mkdtempSync(join(tmpdir(), "promotion-conflict-repo-")); roots.push(repo)
    git(repo, "init", "-b", "base")
    git(repo, "config", "user.email", "motor@test.local")
    git(repo, "config", "user.name", "Motor Test")
    writeFileSync(join(repo, "flow.ts"), "export const value = 'ancestor'\n")
    git(repo, "add", "flow.ts"); git(repo, "commit", "-m", "ancestor")
    git(repo, "switch", "-c", "task")
    writeFileSync(join(repo, "flow.ts"), "export const value = 'task'\n")
    git(repo, "commit", "-am", "task")
    git(repo, "switch", "base")
    writeFileSync(join(repo, "flow.ts"), "export const value = 'base'\n")
    git(repo, "commit", "-am", "base")
    const before = git(repo, "rev-parse", "HEAD")

    const evidence = await new PromotionConflictEvidenceCollector().collect({
      taskId: "task-1", agentId: "agent", repoPath: repo, baseBranch: "base", taskBranch: "task",
    })

    expect(evidence.conflictFiles).toHaveLength(1)
    expect(evidence.conflictFiles[0]).toMatchObject({ path: "flow.ts", kind: "semantic" })
    expect(evidence.conflictFiles[0]?.baseExcerpt).toContain("'base'")
    expect(evidence.conflictFiles[0]?.taskExcerpt).toContain("'task'")
    expect(git(repo, "rev-parse", "HEAD")).toBe(before)
    expect(readFileSync(join(repo, "flow.ts"), "utf8")).toContain("'base'")
    expect(git(repo, "status", "--porcelain")).toBe("")
  })
})

