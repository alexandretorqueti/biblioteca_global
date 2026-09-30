import type { QueueDelivery, QueueMessage } from './QueueMessage.js'
import type { QueueTransport } from './QueueTransport.js'
import { MessageProcessingState } from './MessageProcessingState.js'
import type { Pool } from 'mysql2/promise'
import type { GovernedFailureHandler } from '../governance/GovernedFailureHandler.js'

export interface QueueConsumerConfig {
  queue: string
  maxAttempts: number
}

export type QueueMessageHandler = (message: QueueMessage) => Promise<void>

/**
 * Entrada única do motor para mensagens duráveis.
 *
 * Ack só acontece depois do handler terminar. Falhas transitórias são
 * rejeitadas para o retry do broker; após o limite, vão para a DLQ.
 */
export class QueueConsumer {
  private running = false
  private readonly processingState: MessageProcessingState

  constructor(
    private readonly transport: QueueTransport,
    private readonly handler: QueueMessageHandler,
    private readonly config: QueueConsumerConfig,
    private readonly pool: Pool,
    private readonly governedFailureHandler?: GovernedFailureHandler,
  ) {
    this.processingState = new MessageProcessingState(pool)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.transport.connect()
    await this.transport.consume(this.config.queue, delivery => this.handle(delivery))
  }

  async stop(): Promise<void> {
    this.running = false
    await this.transport.close()
  }

  private async handle(delivery: QueueDelivery): Promise<void> {
    const { message } = delivery
    if (!this.running) return
    if (!message.messageId || !message.type || !message.taskId) {
      if (message.messageId && message.taskId && message.executionId) {
        await this.routeGovernedFailure(message, 'queue_invalid_message', 'QUEUE_DLQ', 'invalid-message')
      }
      await this.transport.deadLetter(delivery, 'invalid-message')
      return
    }
    if (message.attempt > this.config.maxAttempts) {
      await this.routeGovernedFailure(message, 'queue_max_attempts', 'QUEUE_DLQ', 'max-attempts-exceeded')
      await this.transport.deadLetter(delivery, 'max-attempts-exceeded')
      return
    }

    // Tentativa de claim idempotente
    const attempt = delivery.attempt ?? message.attempt ?? 1
    const claimResult = await this.processingState.tryClaim(
      message.messageId,
      message.type,
      message.taskId,
      attempt,
    )

    if (claimResult.alreadyCompleted) {
      // Já foi processado com sucesso anteriormente, ack silencioso
      this.transport.ack(delivery)
      return
    }

    if (claimResult.alreadyProcessing) {
      // Pode ser uma entrega recuperada logo após a queda do processo. Não
      // confirme: passe pelo retry até o lease de processamento expirar.
      this.transport.nack(delivery, false)
      return
    }

    if (!claimResult.claimed) {
      // Estado inesperado, enviar para DLQ
      await this.routeGovernedFailure(message, 'queue_unexpected_state', 'QUEUE_DLQ', 'unexpected-state')
      await this.transport.deadLetter(delivery, 'unexpected-state')
      return
    }

    // Executar o handler
    try {
      await this.handler(message)
      await this.processingState.markCompleted(message.messageId)
      this.transport.ack(delivery)
    } catch (error) {
      console.error(`[QueueConsumer] falha ao processar ${message.messageId}:`, error)
      await this.processingState.markFailed(message.messageId, (error as Error).message)

      // Se atingiu o limite de tentativas, enviar para DLQ
      if (attempt >= this.config.maxAttempts) {
        await this.routeGovernedFailure(message, 'queue_max_attempts', 'QUEUE_DLQ', 'max-attempts-exceeded')
        await this.transport.deadLetter(delivery, 'max-attempts-exceeded')
      } else {
        // Liberar o estado para retry (outro consumo pegará)
        await this.processingState.incrementAttempt(message.messageId)
        this.transport.nack(delivery, false)
      }
    }
  }

  private async routeGovernedFailure(message: QueueMessage, point: string, code: string, detail: string): Promise<void> {
    if (!this.governedFailureHandler) return
    try {
      const subtaskId = Number(message.payload.subtaskId)
      await this.governedFailureHandler.handleFailure(point, {
        taskId: message.taskId,
        subtaskId: Number.isInteger(subtaskId) && subtaskId > 0 ? subtaskId : null,
        executionId: message.executionId,
        generation: message.attempt,
        metadata: { messageType: message.type, reason: detail },
      }, { code, message: detail })
    } catch (error) {
      console.warn('[QueueConsumer] falha ao rotear erro pelo catálogo:', error instanceof Error ? error.message : String(error))
    }
  }
}
