import { describe, expect, it, vi } from "vitest"
import { PromotionRetryOrchestrator } from "../src/promotion-retries/PromotionRetryOrchestrator.js"

const candidate = { taskId: "task-810", blockId: 817, projectSlug: "gerenteagentes", repoPath: "/repo", baseBranch: "base", taskBranch: "task", attempt: 0 }

describe("PromotionRetryOrchestrator", () => {
  it("faz claim antes de retentar e não duplica a mesma tarefa", async () => {
    const repository = { findEligibleCandidates: vi.fn(), claim: vi.fn().mockResolvedValue(true), recordFailure: vi.fn() }
    const port = { retry: vi.fn().mockResolvedValue({ kind: "promoted" }) }
    const subject = new PromotionRetryOrchestrator(repository as never, port)
    subject.schedule(candidate)
    subject.schedule(candidate)
    await vi.waitFor(() => expect(port.retry).toHaveBeenCalled())
    expect(repository.claim).toHaveBeenCalledTimes(1)
    expect(port.retry).toHaveBeenCalledWith({ ...candidate, attempt: 1 })
  })

  it("mantém o bloqueio quando o checkout continua sujo", async () => {
    const repository = { findEligibleCandidates: vi.fn(), claim: vi.fn().mockResolvedValue(true), recordFailure: vi.fn().mockResolvedValue(undefined) }
    const subject = new PromotionRetryOrchestrator(repository as never, { retry: vi.fn().mockResolvedValue({ kind: "still_dirty", reason: "repo sujo" }) })
    subject.schedule(candidate)
    await vi.waitFor(() => expect(repository.recordFailure).toHaveBeenCalledWith(candidate, "repo sujo"))
  })
})
