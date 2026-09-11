import { describe, expect, it } from "vitest"
import { monitorResolutionWorktreeParent, resolutionAttemptSessionIdentity } from "../src/promotion-conflicts/PromotionConflictResolver.js"

const candidate = {
  taskId: "task-p2-811",
  agentId: "gerenteagentes",
  repoPath: "/repo/projects/gerenteagentes",
  baseBranch: "base-desenvolvimento",
  taskBranch: "motor-v2/task-p2-811/integracao",
}

const evidence = {
  taskId: candidate.taskId,
  baseBranch: candidate.baseBranch,
  taskBranch: candidate.taskBranch,
  baseCommit: "a".repeat(40),
  taskCommit: "b".repeat(40),
  mergeBase: "c".repeat(40),
  fingerprint: "d".repeat(64),
  conflictFiles: [],
}

describe("PromotionConflictResolver workspace", () => {
  it("cria a tentativa dentro do workspace autorizado do Monitor", () => {
    const parent = monitorResolutionWorktreeParent(
      "/data/workspace/projects/agentes/programador-senior",
      candidate,
      evidence,
    )

    expect(parent).toBe(
      "/data/workspace/projects/agentes/programador-senior/worktrees/promotion-resolutions/task-p2-811-dddddddddddd",
    )
  })

  it("recusa workspace ausente, relativo ou fora da área de agentes", () => {
    expect(() => monitorResolutionWorktreeParent(null, candidate, evidence)).toThrow("Workspace absoluto")
    expect(() => monitorResolutionWorktreeParent("worktrees/monitor", candidate, evidence)).toThrow("Workspace absoluto")
    expect(() => monitorResolutionWorktreeParent("/tmp/monitor", candidate, evidence)).toThrow("fora da área autorizada")
  })

  it("usa identidade de sessão distinta para cada retry do mesmo conflito", () => {
    const first = resolutionAttemptSessionIdentity(candidate, evidence, "/tmp/attempt-abc123")
    const second = resolutionAttemptSessionIdentity(candidate, evidence, "/tmp/attempt-def456")

    expect(first.key).toContain("task-p2-811:dddddddddddd:attempt-abc123")
    expect(first.label).toBe(first.key)
    expect(second.key).not.toBe(first.key)
    expect(second.label).not.toBe(first.label)
  })
})
