import { randomUUID } from 'node:crypto'
import type { OperationLogEntry, OperationLogger } from '../commands/OperationLogger.js'
import type { QueueMessage } from '../queue/QueueMessage.js'
import type { MySqlDevelopmentExecutionRepository } from './DevelopmentExecutionRepository.js'
import type { GitVerificationIntegrator } from './GitVerificationIntegrator.js'

const EXECUTION_COMPLETED = 'SUBTASK_EXECUTION_COMPLETED'
const VERIFICATION_REQUESTED = 'SUBTASK_VERIFICATION_REQUESTED'

export class SubtaskVerificationConsumer {
  constructor(
    private readonly repository: MySqlDevelopmentExecutionRepository,
    private readonly integrator: GitVerificationIntegrator,
    private readonly operationLogger?: OperationLogger,
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type === EXECUTION_COMPLETED) return this.requestVerification(message)
    if (message.type === VERIFICATION_REQUESTED) return this.verify(message)
  }

  private async requestVerification(message: QueueMessage): Promise<void> {
    const operationId = randomUUID()
    const subtaskId = this.subtaskId(message)
    await this.log(operationId, 1, message, { phase: 'received', outcome: 'executed', subtaskId })
    const context = await this.repository.getExecutionContext(message.taskId, subtaskId, 'delivered')
    if (!context) {
      await this.log(operationId, 2, message, { phase: 'rejected', outcome: 'skipped', subtaskId, reasonCode: 'subtask_not_delivered' })
      return
    }
    const next = await this.repository.requestVerification(context, message)
    await this.log(operationId, 2, message, {
      phase: 'completed', outcome: 'succeeded', subtaskId,
      result: { nextMessageId: next.messageId, nextMessageType: next.type },
    })
  }

  private async verify(message: QueueMessage): Promise<void> {
    const operationId = randomUUID()
    const subtaskId = this.subtaskId(message)
    await this.log(operationId, 1, message, { phase: 'received', outcome: 'executed', subtaskId })
    const context = await this.repository.getExecutionContext(message.taskId, subtaskId, 'verifying')
    if (!context) {
      await this.log(operationId, 2, message, { phase: 'rejected', outcome: 'skipped', subtaskId, reasonCode: 'subtask_not_verifying' })
      return
    }
    try {
      const evidence = await this.integrator.verifyAndIntegrate(context)
      await this.log(operationId, 2, message, {
        phase: 'primitive', outcome: 'succeeded', subtaskId, primitiveCode: 'verify_commit_integrate', result: { ...evidence },
      })
      const messages = await this.repository.completeVerification(context, message, evidence)
      await this.log(operationId, 3, message, {
        phase: 'completed', outcome: 'succeeded', subtaskId,
        result: { verifiedMessageId: messages.verified.messageId, nextMessageId: messages.next.messageId, nextMessageType: messages.next.type },
      })
    } catch (error) {
      await this.log(operationId, 2, message, {
        phase: 'failed', outcome: 'failed', subtaskId, primitiveCode: 'verify_commit_integrate',
        reasonCode: 'verification_or_integration_failed', result: { error: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  }

  private subtaskId(message: QueueMessage): number {
    const value = Number(message.payload.subtaskId)
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${message.type} sem subtaskId válido`)
    return value
  }

  private async log(
    operationId: string, sequence: number, message: QueueMessage,
    data: Pick<OperationLogEntry, 'phase' | 'outcome'> & Partial<Pick<OperationLogEntry, 'subtaskId' | 'primitiveCode' | 'result' | 'reasonCode'>>,
  ): Promise<void> {
    await this.operationLogger?.append({
      operationId, sequence, messageId: message.messageId, messageType: message.type,
      correlationId: message.correlationId, causationId: message.causationId, taskId: message.taskId, ...data,
    })
  }
}
