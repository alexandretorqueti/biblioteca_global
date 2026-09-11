import { describe, expect, it } from "vitest"
import { monitorResolutionWorktreeParent } from "../src/promotion-conflicts/PromotionConflictResolver.js"

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
})
