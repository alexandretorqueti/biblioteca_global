import { describe, expect, it, vi } from "vitest"
import { PromotionConflictOrchestrator } from "../src/promotion-conflicts/PromotionConflictOrchestrator.js"

const candidate = { taskId: "task-1", agentId: "agent", repoPath: "/repo", baseBranch: "base", taskBranch: "task" }
const evidence = { taskId: "task-1", baseBranch: "base", taskBranch: "task", baseCommit: "a".repeat(40), taskCommit: "b".repeat(40), mergeBase: "c".repeat(40), fingerprint: "d".repeat(64), conflictFiles: [] }

describe("PromotionConflictOrchestrator", () => {
  it("agenda sem bloquear, persiste o resultado e não duplica execução concorrente", async () => {
    const repository = { findPendingCandidates: vi.fn(), claim: vi.fn().mockResolvedValue(true), complete: vi.fn(), fail: vi.fn().mockResolvedValue(undefined) }
    const collector = { collect: vi.fn().mockResolvedValue(evidence) }
    const analyzer = { analyze: vi.fn().mockResolvedValue({ recommendation: "human_review", confidence: "medium", report: "ok" }) }
    const orchestrator = new PromotionConflictOrchestrator(repository as never, collector as never, analyzer)
    orchestrator.schedule(candidate)
    orchestrator.schedule(candidate)
    await vi.waitFor(() => expect(repository.complete).toHaveBeenCalled())
    expect(collector.collect).toHaveBeenCalledTimes(1)
    expect(analyzer.analyze).toHaveBeenCalledTimes(1)
  })

  it("recupera candidatos encontrados após restart", async () => {
    const repository = { findPendingCandidates: vi.fn().mockResolvedValue([candidate]), claim: vi.fn().mockResolvedValue(false), complete: vi.fn(), fail: vi.fn() }
    const collector = { collect: vi.fn().mockResolvedValue(evidence) }
    const orchestrator = new PromotionConflictOrchestrator(repository as never, collector as never, { analyze: vi.fn() })
    await orchestrator.reconcilePendingAnalyses()
    await vi.waitFor(() => expect(repository.claim).toHaveBeenCalled())
  })

  it("registra falha do analista sem desbloquear a tarefa", async () => {
    const repository = { findPendingCandidates: vi.fn(), claim: vi.fn().mockResolvedValue(true), complete: vi.fn(), fail: vi.fn().mockResolvedValue(undefined) }
    const collector = { collect: vi.fn().mockResolvedValue(evidence) }
    const orchestrator = new PromotionConflictOrchestrator(repository as never, collector as never, { analyze: vi.fn().mockRejectedValue(new Error("console down")) })
    orchestrator.schedule(candidate)
    await vi.waitFor(() => expect(repository.fail).toHaveBeenCalledWith(evidence.fingerprint, expect.stringContaining("console down")))
    expect(repository.complete).not.toHaveBeenCalled()
  })
})
