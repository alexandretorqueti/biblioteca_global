import { createLogger, describeError } from "../shared/logger.js"
import { ConflictNotReproducibleError, PromotionConflictEvidenceCollector } from "./PromotionConflictEvidenceCollector.js"
import { PromotionConflictRepository } from "./PromotionConflictRepository.js"
import type { PromotionConflictAnalyzerPort, PromotionConflictCandidate, PromotionConflictPromoterPort, PromotionConflictResolverPort } from "./promotion-conflict.types.js"

/** Coordena os gatilhos imediato e pós-reinício sem bloquear o pump do Motor. */
export class PromotionConflictOrchestrator {
  private readonly runningTasks = new Set<string>()
  private readonly lastCheckedAt = new Map<string, number>()
  private readonly logger = createLogger("PromotionConflictOrchestrator")

  constructor(
    private readonly repository: PromotionConflictRepository,
    private readonly collector: PromotionConflictEvidenceCollector,
    private readonly analyzer: PromotionConflictAnalyzerPort,
    private readonly resolver?: PromotionConflictResolverPort,
    private readonly promoter?: PromotionConflictPromoterPort,
  ) {}

  schedule(candidate: PromotionConflictCandidate): void {
    if (this.runningTasks.has(candidate.taskId)) return
    // O pump é frequente. Evita repetir uma simulação Git cara para o mesmo
    // bloqueio; restart limpa apenas este cache, enquanto o fingerprint no
    // banco continua sendo a garantia definitiva de idempotência.
    if (Date.now() - (this.lastCheckedAt.get(candidate.taskId) ?? 0) < 60_000) return
    this.runningTasks.add(candidate.taskId)
    void this.run(candidate).finally(() => {
      this.runningTasks.delete(candidate.taskId)
      this.lastCheckedAt.set(candidate.taskId, Date.now())
    })
  }

  async reconcilePendingAnalyses(): Promise<void> {
    const candidates = await this.repository.findPendingCandidates()
    for (const candidate of candidates) this.schedule(candidate)
  }

  private async run(candidate: PromotionConflictCandidate): Promise<void> {
    let fingerprint: string | null = null
    try {
      const evidence = await this.collector.collect(candidate)
      fingerprint = evidence.fingerprint
      if (!await this.repository.claim(candidate, evidence)) return
      if (!this.resolver || !this.promoter) {
        const result = await this.analyzer.analyze(candidate, evidence)
        await this.repository.complete(evidence.fingerprint, result)
        this.logger.info("Análise automática do conflito concluída", { taskId: candidate.taskId })
        return
      }

      const resolution = await this.resolver.resolve(candidate, evidence)
      if (resolution.kind === "resolved") {
        await this.promoter.promote(candidate, resolution.resolutionBranch)
        await this.repository.complete(evidence.fingerprint, {
          confidence: "high", recommendation: "resolved_automatically", report: resolution.report,
        })
        this.logger.info("Conflito de promoção resolvido automaticamente", { taskId: candidate.taskId })
        return
      }
      if (resolution.kind === "needs_human_review") {
        await this.repository.complete(evidence.fingerprint, {
          confidence: "low", recommendation: "human_review", report: resolution.report,
        })
        return
      }
      await this.repository.fail(evidence.fingerprint, resolution.reason)
    } catch (error) {
      // O conflito sumiu: não é falha, é recuperação. Registrar `fail` deixaria o
      // bloqueio preso e a análise se repetindo a cada ciclo.
      if (error instanceof ConflictNotReproducibleError) {
        await this.recoverVanishedConflict(candidate)
        return
      }
      const reason = describeError(error)
      if (fingerprint) await this.repository.fail(fingerprint, reason).catch(() => undefined)
      this.logger.error("Falha na análise automática do conflito: " + reason, { taskId: candidate.taskId })
    }
  }

  /**
   * Devolve a tarefa ao fluxo quando o merge simulado deixou de conflitar
   * (a base andou ou o conflito foi resolvido por outra via):
   *  - já integrada/deployada -> encerra o bloqueio obsoleto;
   *  - subtarefas ainda abertas -> não é seguro promover, mantém como está;
   *  - caso geral -> promove a própria branch da tarefa.
   */
  private async recoverVanishedConflict(candidate: PromotionConflictCandidate): Promise<void> {
    const state = await this.repository.findTaskState(candidate.taskId)
    if (!state) {
      this.logger.warn("Conflito de promoção não é mais reproduzível, mas a tarefa não foi encontrada", { taskId: candidate.taskId })
      return
    }
    if (state.hasUnfinishedSubtasks) {
      this.logger.info("Conflito de promoção não é mais reproduzível; tarefa segue com subtarefas abertas", { taskId: candidate.taskId })
      return
    }
    if (state.integrationConfirmed || state.deploySucceeded) {
      const resolved = await this.repository.resolvePromotionBlockers(candidate.taskId)
      this.logger.warn("Conflito não é mais reproduzível e a tarefa já está integrada; bloqueio de promoção obsoleto encerrado", { taskId: candidate.taskId, resolvedBlockers: resolved })
      return
    }
    if (!this.promoter || !candidate.projectSlug) {
      this.logger.warn("Conflito não é mais reproduzível, mas não há caminho de promoção disponível", { taskId: candidate.taskId })
      return
    }
    try {
      await this.promoter.promote(candidate, candidate.taskBranch)
      this.logger.info("Conflito não é mais reproduzível; branch da tarefa promovida", { taskId: candidate.taskId })
    } catch (error) {
      this.logger.warn("Conflito não é mais reproduzível, mas a promoção falhou: " + describeError(error), { taskId: candidate.taskId })
    }
  }
}
