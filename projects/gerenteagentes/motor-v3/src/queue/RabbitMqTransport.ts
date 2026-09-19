import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib'
import type { QueueDelivery, QueueMessage, QueuePublishOptions } from './QueueMessage.js'
import type { QueueDeliveryHandler, QueueTransport } from './QueueTransport.js'

export interface RabbitMqTransportConfig {
  url: string
  exchange: string
  prefetch: number
  queue: string
  retryQueue: string
  deadLetterQueue: string
  retryDelayMs: number
}

/** Adaptador RabbitMQ com retry por TTL e fila de mensagens mortas. */
export class RabbitMqTransport implements QueueTransport {
  private connection: ChannelModel | null = null
  private channel: ConfirmChannel | null = null

  constructor(private readonly config: RabbitMqTransportConfig) {}

  async connect(): Promise<void> {
    if (this.channel) return
    this.connection = await amqp.connect(this.config.url)
    this.channel = await this.connection.createConfirmChannel()
    await this.channel.assertExchange(this.config.exchange, 'direct', { durable: true })
    await this.channel.prefetch(this.config.prefetch)
  }

  async publish(queue: string, message: QueueMessage, options: QueuePublishOptions = {}): Promise<void> {
    const channel = this.requireChannel()
    await this.ensureQueue(queue)
    const published = channel.publish(
      this.config.exchange,
      queue,
      Buffer.from(JSON.stringify(message), 'utf8'),
      {
        contentType: 'application/json',
        contentEncoding: 'utf-8',
        persistent: options.persistent ?? true,
        messageId: options.messageId ?? message.messageId,
        correlationId: options.correlationId ?? message.correlationId,
        headers: { causationId: options.causationId ?? message.causationId },
      },
    )
    if (!published) throw new Error(`RabbitMQ não aceitou a mensagem ${message.messageId}`)
    await channel.waitForConfirms()
  }

  async consume(queue: string, handler: QueueDeliveryHandler): Promise<void> {
    const channel = this.requireChannel()
    await this.ensureQueue(queue)
    await channel.consume(queue, async (raw: ConsumeMessage | null) => {
      if (!raw) return
      let message: QueueMessage
      try {
        message = JSON.parse(raw.content.toString('utf8')) as QueueMessage
      } catch (error) {
        console.error('[RabbitMqTransport] mensagem inválida:', error)
        channel.nack(raw, false, false)
        return
      }
      const attempt = this.retryAttempt(raw)
      await handler({
        message: { ...message, attempt: Math.max(message.attempt || 1, attempt) },
        attempt,
        redelivered: raw.fields.redelivered,
        raw,
      })
    }, { noAck: false })
  }

  ack(delivery: QueueDelivery): void {
    this.requireChannel().ack(delivery.raw as ConsumeMessage)
  }

  nack(delivery: QueueDelivery, requeue: boolean): void {
    this.requireChannel().nack(delivery.raw as ConsumeMessage, false, requeue)
  }

  async deadLetter(delivery: QueueDelivery, reason: string): Promise<void> {
    const raw = delivery.raw as ConsumeMessage
    const message = {
      ...delivery.message,
      payload: { ...delivery.message.payload, deadLetterReason: reason },
    }
    const published = this.requireChannel().publish(
      this.config.exchange,
      this.config.deadLetterQueue,
      Buffer.from(JSON.stringify(message), 'utf8'),
      {
        contentType: 'application/json',
        contentEncoding: 'utf-8',
        persistent: true,
        messageId: message.messageId,
        headers: { deadLetterReason: reason },
      },
    )
    if (!published) throw new Error(`RabbitMQ não aceitou a DLQ ${message.messageId}`)
    await this.requireChannel().waitForConfirms()
    this.requireChannel().ack(raw)
  }

  async close(): Promise<void> {
    await this.channel?.close()
    await this.connection?.close()
    this.channel = null
    this.connection = null
  }

  private requireChannel(): ConfirmChannel {
    if (!this.channel) throw new Error('RabbitMqTransport não conectado')
    return this.channel
  }

  private async ensureQueue(queue: string): Promise<void> {
    const channel = this.requireChannel()
    if (queue === this.config.queue) {
      await channel.assertQueue(queue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': this.config.exchange,
          'x-dead-letter-routing-key': this.config.retryQueue,
        },
      })
      await channel.assertQueue(this.config.retryQueue, {
        durable: true,
        arguments: {
          'x-message-ttl': this.config.retryDelayMs,
          'x-dead-letter-exchange': this.config.exchange,
          'x-dead-letter-routing-key': this.config.queue,
        },
      })
      await channel.assertQueue(this.config.deadLetterQueue, { durable: true })
      await channel.bindQueue(this.config.retryQueue, this.config.exchange, this.config.retryQueue)
      await channel.bindQueue(this.config.deadLetterQueue, this.config.exchange, this.config.deadLetterQueue)
    } else {
      await channel.assertQueue(queue, { durable: true })
    }
    await channel.bindQueue(queue, this.config.exchange, queue)
  }

  private retryAttempt(raw: ConsumeMessage): number {
    const deaths = raw.properties.headers?.['x-death']
    if (!Array.isArray(deaths)) return 1
    const retryCount = deaths
      .filter(entry => entry && entry.queue === this.config.retryQueue)
      .reduce((total, entry) => total + Number(entry.count ?? 0), 0)
    return retryCount + 1
  }
}
