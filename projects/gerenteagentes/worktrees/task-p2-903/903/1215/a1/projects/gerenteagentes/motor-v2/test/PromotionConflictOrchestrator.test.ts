import { describe, expect, it, vi } from "vitest"
import { ConflictNotReproducibleError } from "../src/promotion-conflicts/PromotionConflictEvidenceCollector.js"
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

  it("promove somente a branch que o Monitor resolveu e validou", async () => {
    const repository = { findPendingCandidates: vi.fn(), claim: vi.fn().mockResolvedValue(true), complete: vi.fn(), fail: vi.fn().mockResolvedValue(undefined) }
    const collector = { collect: vi.fn().mockResolvedValue(evidence) }
    const resolver = { resolve: vi.fn().mockResolvedValue({ kind: "resolved", resolutionBranch: "motor-v2/promotion-resolution/task-1/abc", resolutionCommit: "e".repeat(40), report: "gates verdes" }) }
    const promoter = { promote: vi.fn().mockResolvedValue(undefined) }
    const orchestrator = new PromotionConflictOrchestrator(repository as never, collector as never, { analyze: vi.fn() }, resolver, promoter)
    orchestrator.schedule(candidate)
    await vi.waitFor(() => expect(promoter.promote).toHaveBeenCalledWith(candidate, "motor-v2/promotion-resolution/task-1/abc"))
    expect(repository.complete).toHaveBeenCalledWith(evidence.fingerprint, expect.objectContaining({ recommendation: "resolved_automatically" }))
  })

  it("promove a própria branch quando o conflito deixou de ser reproduzível", async () => {
    const repository = {
      findPendingCandidates: vi.fn(), claim: vi.fn(), complete: vi.fn(), fail: vi.fn(),
      findTaskState: vi.fn().mockResolvedValue({ integrationConfirmed: false, deploySucceeded: false, hasUnfinishedSubtasks: false }),
      resolvePromotionBlockers: vi.fn(),
    }
    const collector = { collect: vi.fn().mockRejectedValue(new ConflictNotReproducibleError()) }
    const promoter = { promote: vi.fn().mockResolvedValue(undefined) }
    const orchestrator = new PromotionConflictOrchestrator(repository as never, collector as never, { analyze: vi.fn() }, undefined, promoter)
    orchestrator.schedule({ ...candidate, projectSlug: "gerenteagentes" })
    await vi.waitFor(() => expect(promoter.promote).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1" }), "task"))
    expect(repository.fail).not.toHaveBeenCalled()
  })

  it("encerra bloqueio obsoleto quando o conflito sumiu e a tarefa já está integrada", async () => {
    const repository = {
      findPendingCandidates: vi.fn(), claim: vi.fn(), complete: vi.fn(), fail: vi.fn(),
      findTaskState: vi.fn().mockResolvedValue({ integrationConfirmed: true, deploySucceeded: true, hasUnfinishedSubtasks: false }),
      resolvePromotionBlockers: vi.fn().mockResolvedValue(1),
    }
    const collector = { collect: vi.fn().mockRejectedValue(new ConflictNotReproducibleError()) }
    const promoter = { promote: vi.fn() }
    const orchestrator = new PromotionConflictOrchestrator(repository as never, collector as never, { analyze: vi.fn() }, undefined, promoter)
    orchestrator.schedule({ ...candidate, projectSlug: "gerenteagentes" })
    await vi.waitFor(() => expect(repository.resolvePromotionBlockers).toHaveBeenCalledWith("task-1"))
    expect(promoter.promote).not.toHaveBeenCalled()
  })

  it("não promove quando o conflito sumiu mas há subtarefas abertas", async () => {
    const repository = {
      findPendingCandidates: vi.fn(), claim: vi.fn(), complete: vi.fn(), fail: vi.fn(),
      findTaskState: vi.fn().mockResolvedValue({ integrationConfirmed: false, deploySucceeded: false, hasUnfinishedSubtasks: true }),
      resolvePromotionBlockers: vi.fn(),
    }
    const collector = { collect: vi.fn().mockRejectedValue(new ConflictNotReproducibleError()) }
    const promoter = { promote: vi.fn() }
    const orchestrator = new PromotionConflictOrchestrator(repository as never, collector as never, { analyze: vi.fn() }, undefined, promoter)
    orchestrator.schedule({ ...candidate, projectSlug: "gerenteagentes" })
    await vi.waitFor(() => expect(repository.findTaskState).toHaveBeenCalled())
    expect(promoter.promote).not.toHaveBeenCalled()
    expect(repository.resolvePromotionBlockers).not.toHaveBeenCalled()
  })

  it("não promove quando o Monitor considera o conflito ambíguo", async () => {
    const repository = { findPendingCandidates: vi.fn(), claim: vi.fn().mockResolvedValue(true), complete: vi.fn(), fail: vi.fn().mockResolvedValue(undefined) }
    const collector = { collect: vi.fn().mockResolvedValue(evidence) }
    const resolver = { resolve: vi.fn().mockResolvedValue({ kind: "needs_human_review", report: "mudança semântica ambígua" }) }
    const promoter = { promote: vi.fn() }
    const orchestrator = new PromotionConflictOrchestrator(repository as never, collector as never, { analyze: vi.fn() }, resolver, promoter)
    orchestrator.schedule(candidate)
    await vi.waitFor(() => expect(repository.complete).toHaveBeenCalled())
    expect(promoter.promote).not.toHaveBeenCalled()
  })
})
