import type { EventClassifier, ClassificationResult, ErrorInput } from '../classifier/index.js'
import type { ActionExecutor, ActionResult } from '../executor/index.js'
import type { MonitorBridge } from '../monitor-bridge/index.js'
import type { MotorContext } from '../shared/context.js'

export interface GovernedFailureConfig {
  enabled?: boolean
  flagResolver?: (point: string) => boolean | Promise<boolean>
  monitor?: MonitorBridge
  fallback?: (context: MotorContext, error: ErrorInput) => Promise<unknown>
  audit?: (entry: GovernanceAuditEntry) => Promise<void> | void
}

export interface GovernanceAuditEntry {
  point: string
  outcome: 'disabled' | 'classified' | 'executed' | 'uncatalogued' | 'fallback' | 'failed'
  taskId: string
  subtaskId: number | null
  executionId: string
  eventCode?: string
  actionCode?: string
  error?: string
}

export interface GovernedFailureResult {
  governed: boolean
  classification?: ClassificationResult
  action?: ActionResult
  proposal?: { proposalId: string; case: 'A' | 'B' | 'C' }
  fallbackResult?: unknown
}

export class GovernedFailureHandler {
  constructor(
    private readonly classifier: EventClassifier,
    private readonly executor: ActionExecutor,
    private readonly config: GovernedFailureConfig = {},
  ) {}

  async handleFailure(
    point: string,
    context: MotorContext,
    error: ErrorInput,
  ): Promise<GovernedFailureResult> {
    const enabled = await this.isEnabled(point)
    if (!enabled) {
      await this.writeAudit({ point, outcome: 'disabled', ...this.identity(context) })
      return { governed: false, fallbackResult: await this.runFallback(context, error) }
    }

    const normalized = this.normalize(error)
    try {
      const classification = await this.classifier.classify(
        context.taskId,
        context.subtaskId,
        context.generation,
        normalized,
        context,
      )
      if (!classification) {
        await this.writeAudit({ point, outcome: 'uncatalogued', ...this.identity(context) })
        const proposal = this.config.monitor
          ? await this.config.monitor.handleUncataloguedError(this.toPrimitiveContext(context), normalized, true)
          : undefined
        if (proposal) return { governed: true, proposal }
        return { governed: true, fallbackResult: await this.runFallback(context, error) }
      }

      await this.writeAudit({ point, outcome: 'classified', eventCode: classification.event.code, actionCode: classification.action.code, ...this.identity(context) })
      const action = await this.executor.execute(classification.action.id, context)
      await this.writeAudit({ point, outcome: action.success ? 'executed' : 'failed', eventCode: classification.event.code, actionCode: action.actionCode, ...this.identity(context), ...(action.error ? { error: action.error } : {}) })
      return { governed: true, classification, action }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await this.writeAudit({ point, outcome: 'failed', ...this.identity(context), error: message })
      return { governed: true, fallbackResult: await this.runFallback(context, error) }
    }
  }

  private normalize(error: ErrorInput): ErrorInput {
    return { code: error.code, message: error.message ?? 'Erro sem mensagem', stack: error.stack, actionResult: error.actionResult }
  }

  private async isEnabled(point: string): Promise<boolean> {
    if (this.config.flagResolver) return Boolean(await this.config.flagResolver(`governed_failure_${point}`))
    return this.config.enabled ?? true
  }

  private async runFallback(context: MotorContext, error: ErrorInput): Promise<unknown> {
    return this.config.fallback ? this.config.fallback(context, error) : undefined
  }

  private async writeAudit(entry: GovernanceAuditEntry): Promise<void> {
    try { await this.config.audit?.(entry) } catch (error) { console.warn('[GovernedFailureHandler] audit failed:', error) }
  }

  private identity(context: MotorContext): Pick<GovernanceAuditEntry, 'taskId' | 'subtaskId' | 'executionId'> {
    return { taskId: context.taskId, subtaskId: context.subtaskId, executionId: context.executionId }
  }

  private toPrimitiveContext(context: MotorContext): any {
    return { ...context, subtaskId: context.subtaskId ?? undefined }
  }
}
