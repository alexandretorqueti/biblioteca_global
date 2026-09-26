/**
 * Scheduler — gerencia eventos temporais (timeouts, heartbeats, reconciliação)
 * 
 * F4: Scheduler/Reconciler
 * - Timeout de execução (worker parado)
 * - Timeout de silêncio (sem heartbeat)
 * - Reconciliação de tarefas órfãs (ExpirationReconciler adaptado)
 * - Heartbeat de recursos (leases)
 * 
 * Emite eventos no MessageBus para que o EventClassifier possa reagir.
 */

import type { MessageBus } from '../bus/index.js'
import type { PrimitiveContext } from '../primitives/types.js'

export interface SchedulerConfig {
  executionTimeoutMs: number // Tempo máximo de execução
  silenceTimeoutMs: number // Tempo sem heartbeat
  heartbeatIntervalMs: number // Intervalo de heartbeat
  reconciliationIntervalMs: number // Intervalo de reconciliação
}

export interface ActiveExecution {
  taskId: string
  subtaskId?: number
  executionId: string
  startedAt: number
  lastHeartbeat: number
  context: PrimitiveContext
}

export class Scheduler {
  private config: SchedulerConfig
  private bus: MessageBus
  private activeExecutions = new Map<string, ActiveExecution>()
  private timers: NodeJS.Timeout[] = []

  constructor(bus: MessageBus, config: Partial<SchedulerConfig> = {}) {
    this.bus = bus
    this.config = {
      executionTimeoutMs: config.executionTimeoutMs ?? 3600000, // 1 hora
      silenceTimeoutMs: config.silenceTimeoutMs ?? 300000, // 5 minutos
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 60000, // 1 minuto
      reconciliationIntervalMs: config.reconciliationIntervalMs ?? 300000, // 5 minutos
    }
  }

  /**
   * Inicia scheduler (timers periódicos)
   */
  start(): void {
    // Timer de reconciliação
    const reconciliationTimer = setInterval(() => {
      this.reconcile()
    }, this.config.reconciliationIntervalMs)
    this.timers.push(reconciliationTimer)

    // Timer de heartbeat check
    const heartbeatTimer = setInterval(() => {
      this.checkHeartbeats()
    }, this.config.heartbeatIntervalMs)
    this.timers.push(heartbeatTimer)
  }

  /**
   * Para scheduler (limpa timers)
   */
  stop(): void {
    this.timers.forEach(timer => clearInterval(timer))
    this.timers = []
  }

  /**
   * Registra execução ativa
   */
  registerExecution(context: PrimitiveContext): void {
    const execution: ActiveExecution = {
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      executionId: context.executionId,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
      context,
    }

    this.activeExecutions.set(context.executionId, execution)
  }

  /**
   * Atualiza heartbeat de execução
   */
  heartbeat(executionId: string): void {
    const execution = this.activeExecutions.get(executionId)
    if (execution) {
      execution.lastHeartbeat = Date.now()
    }
  }

  /**
   * Remove execução ativa
   */
  unregisterExecution(executionId: string): void {
    this.activeExecutions.delete(executionId)
  }

  /**
   * Reconciliação de tarefas órfãs (ExpirationReconciler adaptado)
   * 
   * Detecta execuções que:
   * - Excederam timeout de execução
   * - Excederam timeout de silêncio (sem heartbeat)
   * 
   * Emite eventos no bus para que o EventClassifier reaja.
   */
  private async reconcile(): Promise<void> {
    const now = Date.now()

    for (const [executionId, execution] of this.activeExecutions.entries()) {
      const executionElapsed = now - execution.startedAt
      const silenceElapsed = now - execution.lastHeartbeat

      // Timeout de execução
      if (executionElapsed > this.config.executionTimeoutMs) {
        await this.bus.send({
          type: 'EXECUTION_TIMEOUT',
          taskId: execution.taskId,
          subtaskId: execution.subtaskId,
          executionId,
          payload: {
            elapsed: executionElapsed,
            timeout: this.config.executionTimeoutMs,
          },
          timestamp: new Date().toISOString(),
        })

        this.unregisterExecution(executionId)
        continue
      }

      // Timeout de silêncio
      if (silenceElapsed > this.config.silenceTimeoutMs) {
        await this.bus.send({
          type: 'SILENCE_TIMEOUT',
          taskId: execution.taskId,
          subtaskId: execution.subtaskId,
          executionId,
          payload: {
            elapsed: silenceElapsed,
            timeout: this.config.silenceTimeoutMs,
          },
          timestamp: new Date().toISOString(),
        })

        this.unregisterExecution(executionId)
      }
    }
  }

  /**
   * Verifica heartbeats (emite evento se necessário)
   */
  private async checkHeartbeats(): Promise<void> {
    const now = Date.now()

    for (const [executionId, execution] of this.activeExecutions.entries()) {
      const silenceElapsed = now - execution.lastHeartbeat

      if (silenceElapsed > this.config.silenceTimeoutMs) {
        await this.bus.send({
          type: 'HEARTBEAT_MISSING',
          taskId: execution.taskId,
          subtaskId: execution.subtaskId,
          executionId,
          payload: {
            elapsed: silenceElapsed,
          },
          timestamp: new Date().toISOString(),
        })
      }
    }
  }

  /**
   * Lista execuções ativas (para debug)
   */
  getActiveExecutions(): ActiveExecution[] {
    return Array.from(this.activeExecutions.values())
  }
}
