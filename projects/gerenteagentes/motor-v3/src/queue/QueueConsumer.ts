import type { QueueDelivery, QueueMessage } from './QueueMessage.js'
import type { QueueTransport } from './QueueTransport.js'

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
  private readonly processing = new Set<string>()
  private readonly processed = new Set<string>()

  constructor(
    private readonly transport: QueueTransport,
    private readonly handler: QueueMessageHandler,
    private readonly config: QueueConsumerConfig,
  ) {}

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
    if (message.attempt > this.config.maxAttempts) {
      await this.transport.deadLetter(delivery, 'max-attempts-exceeded')
      return
    }
    if (this.processed.has(message.messageId) || this.processing.has(message.messageId)) {
      this.transport.ack(delivery)
      return
    }

    this.processing.add(message.messageId)
    try {
      await this.handler(message)
      this.processed.add(message.messageId)
      this.transport.ack(delivery)
    } catch (error) {
      console.error(`[QueueConsumer] falha ao processar ${message.messageId}:`, error)
      if ((delivery.attempt ?? message.attempt) >= this.config.maxAttempts) {
        await this.transport.deadLetter(delivery, 'max-attempts-exceeded')
      } else {
        this.transport.nack(delivery, false)
      }
    } finally {
      this.processing.delete(message.messageId)
    }
  }
}
