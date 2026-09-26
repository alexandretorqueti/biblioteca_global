import { randomUUID } from 'node:crypto'
import type { QueueMessage } from '../queue/QueueMessage.js'
import type { OperationLogger } from '../commands/OperationLogger.js'
import { MySqlDevelopmentExecutionRepository } from './DevelopmentExecutionRepository.js'

export const TASK_READY_FOR_PROGRAMMING = 'TASK_READY_FOR_PROGRAMMING'

/** Consome o fim da análise e transforma-o no primeiro comando de execução. */
export class DevelopmentExecutionConsumer {
  private readonly deployLock?: { isDeployLocked(): Promise<boolean>; requeueForDeployRetry(message: QueueMessage, reason: string): Promise<void> }

  constructor(
    private readonly repository: MySqlDevelopmentExecutionRepository,
    private readonly operationLogger?: OperationLogger,
    deployLock?: { isDeployLocked(): Promise<boolean>; requeueForDeployRetry(message: QueueMessage, reason: string): Promise<void> },
  ) {
    this.deployLock = deployLock
  }

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== TASK_READY_FOR_PROGRAMMING) return

    // Deploy atômico: verifica se o lock de deploy está ativo antes de reservar subtarefa.
    // Se locked, loga 'deploy_in_progress' e reenfileira com delay de 30s.
    if (this.deployLock) {
      const locked = await this.deployLock.isDeployLocked()
      if (locked) {
        const operationId = randomUUID()
        await this.operationLogger?.append({
          operationId, sequence: 1, phase: 'rejected', outcome: 'skipped',
          messageId: message.messageId, messageType: message.type,
          correlationId: message.correlationId, causationId: message.causationId,
          taskId: message.taskId, reasonCode: 'deploy_in_progress',
        })
        await this.deployLock.requeueForDeployRetry(message, 'deploy_in_progress')
        return
      }
    }

    const operationId = randomUUID()
    await this.operationLogger?.append({
      operationId, sequence: 1, phase: 'received', outcome: 'executed',
      messageId: message.messageId, messageType: message.type,
      correlationId: message.correlationId, causationId: message.causationId,
      taskId: message.taskId,
    })

    const reserved = await this.repository.reserveNextSubtask(message.taskId, message)
    if (!reserved) {
      await this.operationLogger?.append({
        operationId, sequence: 2, phase: 'rejected', outcome: 'skipped',
        messageId: message.messageId, messageType: message.type,
        correlationId: message.correlationId, causationId: message.causationId,
        taskId: message.taskId, reasonCode: 'no_eligible_subtask',
      })
      return
    }
    if ('kind' in reserved && reserved.kind === 'capacity_waiting') {
      await this.operationLogger?.append({
        operationId, sequence: 2, phase: 'rejected', outcome: 'skipped',
        messageId: message.messageId, messageType: message.type,
        correlationId: message.correlationId, causationId: message.causationId,
        taskId: message.taskId, reasonCode: reserved.reason,
        result: { queue: 'motor_execution_wait_queue' },
      })
      return
    }
    if ('kind' in reserved && reserved.kind === 'task_completed') {
      // Camada B do invariante de conclusão: a tarefa tinha todas as subtarefas
      // finais sem terminal_status (escrita externa/bypass) e foi reconciliada.
      await this.operationLogger?.append({
        operationId, sequence: 2, phase: 'primitive', outcome: 'succeeded',
        messageId: message.messageId, messageType: message.type,
        correlationId: message.correlationId, causationId: message.causationId,
        taskId: message.taskId,
        primitiveCode: 'complete_task_by_reconciliation',
        result: { nextMessageId: reserved.message.messageId, nextMessageType: reserved.message.type },
      })
      await this.operationLogger?.append({
        operationId, sequence: 3, phase: 'completed', outcome: 'succeeded',
        messageId: message.messageId, messageType: message.type,
        correlationId: message.correlationId, causationId: message.causationId,
        taskId: message.taskId,
        result: { reason: 'reconciled_completion', nextMessageType: reserved.message.type },
      })
      return
    }
    if (!('subtaskId' in reserved)) return

    await this.operationLogger?.append({
      operationId, sequence: 2, phase: 'primitive', outcome: 'succeeded',
      messageId: message.messageId, messageType: message.type,
      correlationId: message.correlationId, causationId: message.causationId,
      taskId: message.taskId, subtaskId: reserved.subtaskId,
      primitiveCode: 'claim_subtask_atomic',
      result: { seq: reserved.seq, executionId: reserved.message.executionId },
    })
    await this.operationLogger?.append({
      operationId, sequence: 3, phase: 'completed', outcome: 'succeeded',
      messageId: message.messageId, messageType: message.type,
      correlationId: message.correlationId, causationId: message.causationId,
      taskId: message.taskId, subtaskId: reserved.subtaskId,
      result: { nextMessageId: reserved.message.messageId, nextMessageType: reserved.message.type, seq: reserved.seq },
    })
  }
}
