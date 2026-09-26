import type { QueueDelivery, QueueMessage } from './QueueMessage.js'
import type { QueueTransport } from './QueueTransport.js'
import { MessageProcessingState } from './MessageProcessingState.js'
import type { Pool } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import type { MotorActivityGate } from './MotorActivityGate.js'

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
    private readonly activityGate?: MotorActivityGate,
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
      await this.transport.deadLetter(delivery, 'invalid-message')
      return
    }
    if (this.activityGate?.isActivityStart(message.type) && !(await this.activityGate.isActive())) {
      await this.deferUntilMotorIsActive(delivery)
      return
    }
    if (message.attempt > this.config.maxAttempts) {
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
        await this.transport.deadLetter(delivery, 'max-attempts-exceeded')
      } else {
        // Liberar o estado para retry (outro consumo pegará)
        await this.processingState.incrementAttempt(message.messageId)
        this.transport.nack(delivery, false)
      }
    }
  }

  private async deferUntilMotorIsActive(delivery: QueueDelivery): Promise<void> {
    const message = delivery.message
    const deferredMessageId = randomUUID()
    const delaySeconds = Math.max(1, Number(process.env.MOTOR_INACTIVE_RETRY_SECONDS || 15))
    await this.pool.query(
      `INSERT INTO motor_outbox
        (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,
         correlation_id,causation_id,status,attempt)
       VALUES (?,?,?,?,?,?,DATE_ADD(NOW(), INTERVAL ? SECOND),?,?,'pending',0)`,
      [deferredMessageId, message.type, this.config.queue, message.taskId, message.executionId,
        JSON.stringify(message.payload), delaySeconds, message.correlationId ?? message.messageId, message.messageId],
    )
    console.info(`[QueueConsumer] Motor inativo; atividade ${message.type} adiada por ${delaySeconds}s`)
    this.transport.ack(delivery)
  }
}
