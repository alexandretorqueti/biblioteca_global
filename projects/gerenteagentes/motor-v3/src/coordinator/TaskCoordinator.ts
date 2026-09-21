import type { MessageBus } from '../bus/MessageBus.js'
import type { QueueMessage } from '../queue/QueueMessage.js'
import type { AnalysisOutcome } from '../analysis/AnalystReply.js'
import type { DerivedTaskStatus } from '../status/DerivedTaskStatus.js'
import { randomUUID } from 'node:crypto'
import { CommandPolicyResolver, type CommandPolicyRepository, type OperationLogger } from '../commands/index.js'

export type TaskLifecycleStatus = DerivedTaskStatus

export interface TaskSnapshot {
  taskId: string
  title: string
  description: string
  taskType: string
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
  commandPolicies?: CommandPolicyRepository
  operationLogger?: OperationLogger
  publishTaskReady?: (source: QueueMessage, payload: Record<string, unknown>) => Promise<void>
}

// Criar/enfileirar apenas registra a tarefa. Toda tarefa nasce pausada e a
// análise só pode começar por uma retomada explícita depois de `paused_at`
// ser removido pela API.
const ANALYSIS_COMMANDS = new Set(['TASK_RESUME_REQUESTED'])

/**
 * Coordena a decisão inicial da tarefa sem conhecer RabbitMQ nem HTTP.
 *
 * O consumidor entrega comandos aqui. O coordenador consulta o estado atual,
 * faz o claim atômico e só então chama o runner do analista.
 */
export class TaskCoordinator {
  private readonly executionIdFactory: (message: QueueMessage) => string
  private readonly commandResolver = new CommandPolicyResolver()
  private readonly commandPolicies?: CommandPolicyRepository
  private readonly operationLogger?: OperationLogger
  private readonly publishTaskReady?: (source: QueueMessage, payload: Record<string, unknown>) => Promise<void>

  constructor(
    private readonly repository: TaskCoordinatorRepository,
    private readonly runner: AnalysisRunner,
    private readonly bus: MessageBus,
    config: TaskCoordinatorConfig = {},
  ) {
    this.executionIdFactory = config.analysisExecutionId ?? ((message) => `exec-analyze-${message.taskId}-${message.messageId}-attempt-${message.attempt || 1}`)
    this.commandPolicies = config.commandPolicies
    this.operationLogger = config.operationLogger
    this.publishTaskReady = config.publishTaskReady
  }

  async handle(message: QueueMessage): Promise<void> {
    if (!ANALYSIS_COMMANDS.has(message.type)) return

    const operationId = randomUUID()
    await this.log(operationId, 1, 'received', 'executed', message)
    const task = await this.repository.getTask(message.taskId)
    if (!task) {
      await this.log(operationId, 2, 'rejected', 'rejected', message, { reasonCode: 'task_not_found' })
      await this.emit('TASK_IGNORED', message, { reason: 'not_found' })
      return
    }

    if (this.commandPolicies) {
      const governed = await this.commandPolicies.findByMessageType(message.type)
      const decision = this.commandResolver.decide(governed?.command, governed?.policies ?? [], {
        paused: task.paused || task.status === 'paused',
        terminal: task.terminal || ['cancelled', 'completed', 'failed'].includes(task.status),
        blocked: task.status === 'blocked',
        subtaskCount: task.subtaskCount,
        analysisClaimed: task.analysisStartedAt !== null,
      })
      if (decision.kind === 'reject') {
        await this.log(operationId, 2, 'rejected', 'rejected', message, {
          commandCode: decision.command?.code,
          reasonCode: decision.reasonCode,
          result: { evaluatedPolicies: decision.evaluatedPolicies },
        })
        if (decision.reasonCode === 'task_has_plan' || decision.reasonCode === 'analysis_already_claimed') {
          await this.emitTaskReady(message, { reason: decision.reasonCode, subtaskCount: task.subtaskCount })
        } else {
          await this.emit('TASK_IGNORED', message, { reason: decision.reasonCode })
        }
        return
      }
      if (decision.policy.actionCode !== 'A21_RESUME_TASK_ANALYSIS') {
        await this.log(operationId, 2, 'rejected', 'rejected', message, {
          commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version,
          actionCode: decision.policy.actionCode, reasonCode: 'unsupported_command_action',
        })
        await this.emit('TASK_IGNORED', message, { reason: 'unsupported_command_action' })
        return
      }
      await this.log(operationId, 2, 'decision', 'executed', message, {
        commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version,
        actionCode: decision.policy.actionCode,
      })
      await this.log(operationId, 3, 'action', 'executed', message, {
        commandCode: decision.command.code, policyCode: decision.policy.code, policyVersion: decision.policy.version,
        actionCode: decision.policy.actionCode,
      })
    }

    const ignoredReason = this.getIgnoredReason(task)
    if (ignoredReason) {
      await this.log(operationId, 4, 'rejected', 'rejected', message, { reasonCode: ignoredReason })
      await this.emit('TASK_IGNORED', message, { reason: ignoredReason })
      return
    }

    if (task.subtaskCount > 0 || task.analysisStartedAt !== null) {
      await this.log(operationId, 4, 'rejected', 'rejected', message, { reasonCode: task.subtaskCount > 0 ? 'task_has_plan' : 'analysis_already_claimed' })
      await this.emitTaskReady(message, {
        reason: task.subtaskCount > 0 ? 'plan_exists' : 'analysis_already_started',
        subtaskCount: task.subtaskCount,
      })
      return
    }

    const executionId = this.executionIdFactory(message)
    const analysisAttempt = message.attempt || 1
    const claimed = await this.repository.claimAnalysis(task.taskId, executionId)
    await this.log(operationId, 4, 'primitive', claimed ? 'succeeded' : 'rejected', message, { primitiveCode: 'claim_analysis_atomic', result: { executionId, analysisAttempt }, reasonCode: claimed ? undefined : 'analysis_already_claimed' })
    if (!claimed) {
      await this.emit('TASK_IGNORED', message, { reason: 'analysis_already_claimed', executionId, analysisAttempt })
      return
    }

    await this.emit('ANALYSIS_SELECTED', message, { executionId, analysisAttempt })
    await this.log(operationId, 5, 'primitive', 'succeeded', message, { primitiveCode: 'emit_analysis_selected', result: { executionId, analysisAttempt } })
    try {
      await this.emit('ANALYSIS_STARTED', message, { executionId, analysisAttempt })
      const outcome = await this.runner.start(task, executionId)
      await this.log(operationId, 6, 'primitive', 'succeeded', message, { primitiveCode: 'start_analyst', result: { executionId, analysisAttempt, outcome: outcome.kind } })
      await this.repository.persistAnalysis(task.taskId, executionId, outcome)
      await this.repository.releaseAnalysisClaim(task.taskId, executionId)
      if (outcome.kind === 'questions') {
        await this.emit('ANALYSIS_CLARIFICATION_REQUESTED', message, { executionId, analysisAttempt, questionCount: outcome.questions.length })
      } else {
        await this.emit('ANALYSIS_COMPLETED', message, { executionId, analysisAttempt, subtaskCount: outcome.subtasks.length })
        await this.emitTaskReady(message, { executionId, analysisAttempt, subtaskCount: outcome.subtasks.length })
      }
      await this.log(operationId, 7, 'completed', 'succeeded', message, { result: { executionId, analysisAttempt, outcome: outcome.kind } })
    } catch (error) {
      await this.repository.releaseAnalysisClaim(task.taskId, executionId)
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.log(operationId, 6, 'primitive', 'failed', message, { primitiveCode: 'start_analyst', result: { executionId, analysisAttempt, error: errorMessage }, reasonCode: 'analyst_failed' })
      await this.log(operationId, 7, 'failed', 'failed', message, { result: { executionId, analysisAttempt, error: errorMessage }, reasonCode: 'analyst_failed' })
      await this.emit('ANALYSIS_FAILED', message, {
        executionId,
        analysisAttempt,
        error: errorMessage,
      })
      throw error
    }
  }

  private async emitTaskReady(message: QueueMessage, payload: Record<string, unknown>): Promise<void> {
    // A persistência precisa propagar falhas ao QueueConsumer. O MessageBus
    // deliberadamente captura erros de handlers e não pode ser a garantia de durabilidade.
    await this.publishTaskReady?.(message, payload)
    await this.emit('TASK_READY_FOR_PROGRAMMING', message, payload)
  }

  private async log(operationId: string, sequence: number, phase: 'received' | 'decision' | 'action' | 'primitive' | 'completed' | 'failed' | 'rejected', outcome: 'pending' | 'executed' | 'skipped' | 'rejected' | 'succeeded' | 'failed', message: QueueMessage, extra: Omit<Parameters<OperationLogger['append']>[0], 'operationId' | 'sequence' | 'phase' | 'outcome' | 'messageId' | 'messageType' | 'correlationId' | 'causationId' | 'taskId'> = {}): Promise<void> {
    if (!this.operationLogger) return
    await this.operationLogger.append({ operationId, sequence, phase, outcome, messageId: message.messageId, messageType: message.type, correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, ...extra })
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
