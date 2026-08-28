/**
 * MotorMonitorStep - Etapa 4
 * 
 * Migra o Monitor Motor para usar ResourceLease.
 * Garante que apenas uma tarefa por vez pode solicitar correções ao monitor.
 */

import type { AgentRuntimeDriver } from '@gerente-agentes/openclaw-runtime-driver'
import { ResourceLeaseService } from '../resources/ResourceLeaseService.js'
import { RESOURCE_KEYS } from '../shared/types/resources.js'
import type { ExecutionContext } from '../shared/types/execution.js'

export interface MotorFixInput {
  taskId: string
  subtaskId: string
  reason: string
  evidence: {
    command: string
    excerpt: string
  }
}

export type MotorFixResult =
  | { kind: 'success'; runId: string }
  | { kind: 'waiting_resource'; resourceKey: string; waitId: number; position: number }
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
  maxWaitSeconds: 600, // 10 minutos
  maxAttempts: 60, // 5 minutos com intervalos de 5s
  heartbeatIntervalMs: 5000,
}

export class MotorMonitorStep {
  private config: MotorMonitorStepConfig

  constructor(
    private driver: AgentRuntimeDriver,
    private resourceLease: ResourceLeaseService,
    config: Partial<MotorMonitorStepConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Executa correção via Monitor Motor
   */
  async execute(input: MotorFixInput, context: ExecutionContext): Promise<MotorFixResult> {
    const resourceKey = RESOURCE_KEYS.motorMonitor()

    // 1. Adquire recurso monitor
    const acquireResult = await this.resourceLease.acquire(
      resourceKey,
      context.executionId,
      context.taskId,
      this.config.maxWaitSeconds
    )

    if (acquireResult.kind === 'waiting') {
      return {
        kind: 'waiting_resource',
        resourceKey,
        waitId: acquireResult.waitId,
        position: acquireResult.position,
      }
    }

    if (acquireResult.kind === 'denied') {
      return {
        kind: 'failed',
        reason: `Não foi possível adquirir monitor: ${acquireResult.reason}`,
      }
    }

    const lease = acquireResult.lease

    try {
      // 2. Envia missão ao monitor
      const mission = this.buildMission(input, context)
      
      const sendResult = await this.driver.sendMessage({
        agentId: this.config.monitorAgentId,
        sessionKey: this.config.monitorSessionKey,
        message: mission,
      })

      if (!sendResult.ok) {
        return {
          kind: 'failed',
          reason: `Falha ao enviar missão ao monitor: ${sendResult.reason ?? 'erro desconhecido'}`,
        }
      }

      const runId = sendResult.runId

      // 3. Aguarda conclusão com heartbeat
      const fixResult = await this.waitForCompletion(runId, lease.resourceKey, context.executionId, lease.fencingToken)

      return fixResult
    } finally {
      // 4. Libera recurso
      await this.resourceLease.release(
        lease.resourceKey,
        context.executionId,
        lease.fencingToken
      )
    }
  }

  /**
   * Aguarda conclusão do run do monitor
   */
  private async waitForCompletion(
    runId: string,
    resourceKey: string,
    executionId: string,
    fencingToken: number
  ): Promise<MotorFixResult> {
    let attempts = 0

    while (attempts < this.config.maxAttempts) {
      // Renova heartbeat
      const renewResult = await this.resourceLease.renew(
        resourceKey,
        executionId,
        fencingToken
      )

      if (renewResult.kind === 'lost') {
        return {
          kind: 'failed',
          reason: 'Lease do monitor perdido durante execução',
        }
      }

      // Verifica status do run
      const status = await this.getRunStatus(runId)

      if (status === 'completed') {
        return { kind: 'success', runId }
      }

      if (status === 'failed') {
        return { kind: 'failed', reason: 'Monitor falhou durante execução' }
      }

      // Aguarda antes de próxima verificação
      await this.sleep(this.config.heartbeatIntervalMs)
      attempts++
    }

    return {
      kind: 'timeout',
      reason: `Monitor não completou em ${(this.config.maxAttempts * this.config.heartbeatIntervalMs) / 1000} segundos`,
    }
  }

  /**
   * Obtém status do run do monitor
   */
  private async getRunStatus(runId: string): Promise<'pending' | 'running' | 'completed' | 'failed'> {
    try {
      const result = await this.driver.getRunStatus(runId)
      return result.status
    } catch {
      return 'failed'
    }
  }

  /**
   * Constrói mensagem de missão para o monitor
   */
  private buildMission(input: MotorFixInput, context: ExecutionContext): string {
    return `## Missão Motor Fix

**Tarefa**: ${context.taskId}
**Subtarefa**: ${input.subtaskId}
**Execution ID**: ${context.executionId}

### Problema Identificado
${input.reason}

### Evidência
**Comando**: \`${input.evidence.command}\`
**Output**:
\`\`\`
${input.evidence.excerpt}
\`\`\`

### Instruções
1. Analise o problema identificado
2. Implemente a correção necessária
3. Execute testes para validar
4. Commit das alterações

**Importante**: Esta é uma correção do próprio motor. Seja conservador e foque apenas no problema específico.`
  }

  /**
   * Helper para sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
