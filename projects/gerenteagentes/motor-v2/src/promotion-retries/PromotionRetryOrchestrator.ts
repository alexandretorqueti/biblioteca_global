import { createLogger, describeError } from "../shared/logger.js"
import { PromotionRetryRepository } from "./PromotionRetryRepository.js"
import type { PromotionRetryCandidate, PromotionRetryPort } from "./promotion-retry.types.js"

/** Retenta apenas bloqueios transitórios e sempre deixa o bloqueio ativo até a promoção real. */
export class PromotionRetryOrchestrator {
  private readonly running = new Set<string>()
  private readonly logger = createLogger("PromotionRetryOrchestrator")

  constructor(private readonly repository: PromotionRetryRepository, private readonly retryPort: PromotionRetryPort) {}

  async reconcile(): Promise<void> {
    for (const candidate of await this.repository.findEligibleCandidates()) this.schedule(candidate)
  }

  schedule(candidate: PromotionRetryCandidate): void {
    if (this.running.has(candidate.taskId)) return
    this.running.add(candidate.taskId)
    void this.run(candidate).finally(() => this.running.delete(candidate.taskId))
  }

  private async run(candidate: PromotionRetryCandidate): Promise<void> {
    try {
      if (!await this.repository.claim(candidate)) return
      const result = await this.retryPort.retry({ ...candidate, attempt: candidate.attempt + 1 })
      if (result.kind === "promoted" || result.kind === "conflict") return
      await this.repository.recordFailure(candidate, result.reason)
    } catch (error) {
      const reason = describeError(error)
      await this.repository.recordFailure(candidate, reason).catch(() => undefined)
      this.logger.error("Falha na retentativa de promoção: " + reason, { taskId: candidate.taskId })
    }
  }
}
