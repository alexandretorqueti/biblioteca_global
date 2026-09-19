import type { MessageBus } from '../bus/MessageBus.js'
import type { QueueMessage } from '../queue/QueueMessage.js'
import type { AnalysisOutcome } from '../analysis/AnalystReply.js'

export type TaskLifecycleStatus = 'planned' | 'running' | 'paused' | 'blocked' | 'cancelled' | 'completed' | 'failed'

export interface TaskSnapshot {
  taskId: string
  title: string
  description: string
  agentId: string
  projectSlug: string | null
  repoPath: string
  status: TaskLifecycleStatus
  paused: boolean
  terminal: boolean
  analysisStartedAt: string | null
  subtaskCount: number
}

/**
 * Porta mínima de persistência do coordenador.
 *
 * A implementação MySQL será adicionada no ciclo de outbox/persistência. O
 * método claimAnalysis precisa ser atômico no banco (UPDATE condicional ou
 * lock transacional); ele é a proteção definitiva contra duas análises.
 */
export interface TaskCoordinatorRepository {
  getTask(taskId: string): Promise<TaskSnapshot | null>
  claimAnalysis(taskId: string, executionId: string): Promise<boolean>
  releaseAnalysisClaim(taskId: string, executionId: string): Promise<void>
  persistAnalysis(taskId: string, executionId: string, outcome: AnalysisOutcome): Promise<void>
}

export interface AnalysisRunner {
  start(task: TaskSnapshot, executionId: string): Promise<AnalysisOutcome>
}

export interface TaskCoordinatorConfig {
  analysisExecutionId?: (message: QueueMessage) => string
}

const ANALYSIS_COMMANDS = new Set(['TASK_CREATED', 'TASK_ENQUEUED', 'TASK_RESUME_REQUESTED'])

/**
 * Coordena a decisão inicial da tarefa sem conhecer RabbitMQ nem HTTP.
 *
 * O consumidor entrega comandos aqui. O coordenador consulta o estado atual,
 * faz o claim atômico e só então chama o runner do analista.
 */
export class TaskCoordinator {
  private readonly executionIdFactory: (message: QueueMessage) => string

  constructor(
    private readonly repository: TaskCoordinatorRepository,
    private readonly runner: AnalysisRunner,
    private readonly bus: MessageBus,
    config: TaskCoordinatorConfig = {},
  ) {
    this.executionIdFactory = config.analysisExecutionId ?? ((message) => `exec-analyze-${message.taskId}-${message.messageId}`)
  }

  async handle(message: QueueMessage): Promise<void> {
    if (!ANALYSIS_COMMANDS.has(message.type)) return

    const task = await this.repository.getTask(message.taskId)
    if (!task) {
      await this.emit('TASK_IGNORED', message, { reason: 'not_found' })
      return
    }

    const ignoredReason = this.getIgnoredReason(task)
    if (ignoredReason) {
      await this.emit('TASK_IGNORED', message, { reason: ignoredReason })
      return
    }

    if (task.subtaskCount > 0 || task.analysisStartedAt !== null) {
      await this.emit('TASK_READY_FOR_PROGRAMMING', message, {
        reason: task.subtaskCount > 0 ? 'plan_exists' : 'analysis_already_started',
        subtaskCount: task.subtaskCount,
      })
      return
    }

    const executionId = this.executionIdFactory(message)
    const claimed = await this.repository.claimAnalysis(task.taskId, executionId)
    if (!claimed) {
      await this.emit('TASK_IGNORED', message, { reason: 'analysis_already_claimed', executionId })
      return
    }

    await this.emit('ANALYSIS_SELECTED', message, { executionId })
    try {
      await this.emit('ANALYSIS_STARTED', message, { executionId })
      const outcome = await this.runner.start(task, executionId)
      await this.repository.persistAnalysis(task.taskId, executionId, outcome)
      await this.repository.releaseAnalysisClaim(task.taskId, executionId)
      if (outcome.kind === 'questions') {
        await this.emit('ANALYSIS_CLARIFICATION_REQUESTED', message, { executionId, questionCount: outcome.questions.length })
      } else {
        await this.emit('ANALYSIS_COMPLETED', message, { executionId, subtaskCount: outcome.subtasks.length })
        await this.emit('TASK_READY_FOR_PROGRAMMING', message, { executionId, subtaskCount: outcome.subtasks.length })
      }
    } catch (error) {
      await this.repository.releaseAnalysisClaim(task.taskId, executionId)
      await this.emit('ANALYSIS_FAILED', message, {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private getIgnoredReason(task: TaskSnapshot): string | null {
    if (task.paused || task.status === 'paused') return 'paused'
    if (task.terminal || ['cancelled', 'completed', 'failed'].includes(task.status)) return 'terminal'
    if (task.status === 'blocked') return 'blocked'
    return null
  }

  private async emit(eventName: string, source: QueueMessage, payload: Record<string, unknown>): Promise<void> {
    await this.bus.emit(eventName, {
      taskId: source.taskId,
      executionId: payload.executionId as string ?? source.executionId,
      correlationId: source.correlationId ?? source.messageId,
      payload: {
        ...payload,
        sourceMessageId: source.messageId,
        sourceType: source.type,
      },
    })
  }
}
