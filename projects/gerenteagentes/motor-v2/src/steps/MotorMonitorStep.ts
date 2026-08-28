/**
 * MotorMonitorStep - Correção via Monitor Motor com lock exclusivo
 */

import type { AgentRuntimeDriver } from '../shared/types/agent-runtime.js'
import { ResourceLeaseService } from '../resources/ResourceLeaseService.js'
import type { ResourceKey } from '../shared/types/resources.js'
import { RESOURCE_KEYS } from '../shared/types/resources.js'
import type { ExecutionContext } from '../shared/types/execution.js'

export interface MotorFixInput {
  taskId: string
  subtaskId: string
  reason: string
  evidence: { command: string; excerpt: string }
}

export type MotorFixResult =
  | { kind: 'success'; runId: string }
  | { kind: 'waiting_resource'; resourceKey: ResourceKey; waitId: number; position: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'timeout'; reason: string }

export interface MotorMonitorStepConfig {
  monitorAgentId: string
  monitorSessionKey: string
  maxWaitSeconds: number
  maxAttempts: number
  heartbeatIntervalMs: number
}

const DEFAULT_CONFIG: MotorMonitorStepConfig = {
  monitorAgentId: 'programador-senior',
  monitorSessionKey: 'agent:programador-senior:monitor',
  maxWaitSeconds: 600,
  maxAttempts: 60,
  heartbeatIntervalMs: 5000,
}

export class MotorMonitorStep {
  private driver: AgentRuntimeDriver
  private resourceLease: ResourceLeaseService
  private config: MotorMonitorStepConfig

  constructor(
    driver: AgentRuntimeDriver,
    resourceLease: ResourceLeaseService,
    config: Partial<MotorMonitorStepConfig> = {}
  ) {
    this.driver = driver
    this.resourceLease = resourceLease
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async execute(input: MotorFixInput, context: ExecutionContext): Promise<MotorFixResult> {
    const resourceKey = RESOURCE_KEYS.motorMonitor()

    const acquireResult = await this.resourceLease.acquire(
      resourceKey, context.executionId, context.taskId, this.config.maxWaitSeconds
    )

    if (acquireResult.kind === 'waiting') {
      return { kind: 'waiting_resource', resourceKey, waitId: acquireResult.waitId, position: acquireResult.position }
    }

    if (acquireResult.kind === 'denied') {
      return { kind: 'failed', reason: `Monitor indisponível: ${acquireResult.reason}` }
    }

    const lease = acquireResult.lease

    try {
      const mission = this.buildMission(input, context)
      const sendResult = await this.driver.sendMessage({
        agentId: this.config.monitorAgentId,
        sessionKey: this.config.monitorSessionKey,
        message: mission,
      })

      if (!sendResult.ok) {
        return { kind: 'failed', reason: `Falha ao enviar missão: ${sendResult.reason ?? 'erro'}` }
      }

      const runId = sendResult.runId!
      return await this.waitForCompletion(runId, lease.resourceKey, context.executionId, lease.fencingToken)
    } finally {
      await this.resourceLease.release(lease.resourceKey, context.executionId, lease.fencingToken)
    }
  }

  private async waitForCompletion(
    runId: string, resourceKey: ResourceKey, executionId: string, fencingToken: number
  ): Promise<MotorFixResult> {
    let attempts = 0

    while (attempts < this.config.maxAttempts) {
      const renewResult = await this.resourceLease.renew(resourceKey, executionId, fencingToken)
      if (renewResult.kind === 'lost') {
        return { kind: 'failed', reason: 'Lease perdido durante execução' }
      }

      const status = await this.driver.getRunStatus(runId)
      if (status.status === 'completed') return { kind: 'success', runId }
      if (status.status === 'failed') return { kind: 'failed', reason: 'Monitor falhou' }

      await this.sleep(this.config.heartbeatIntervalMs)
      attempts++
    }

    return { kind: 'timeout', reason: `Timeout: ${this.config.maxAttempts * this.config.heartbeatIntervalMs / 1000}s` }
  }

  private buildMission(input: MotorFixInput, context: ExecutionContext): string {
    return `## Missão Motor Fix\n\n**Tarefa**: ${context.taskId}\n**Subtarefa**: ${input.subtaskId}\n\n### Problema\n${input.reason}\n\n### Evidência\n\`${input.evidence.command}\`\n\`\`\`\n${input.evidence.excerpt}\n\`\`\``
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
