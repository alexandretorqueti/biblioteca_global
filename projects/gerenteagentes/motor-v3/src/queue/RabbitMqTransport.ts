import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib'
import type { QueueDelivery, QueueMessage, QueuePublishOptions } from './QueueMessage.js'
import type { QueueDeliveryHandler, QueueTransport } from './QueueTransport.js'

export interface RabbitMqTransportConfig {
  url: string
  exchange: string
  prefetch: number
}

/** Adaptador RabbitMQ. A topologia (DLQ/retry) fica sob responsabilidade do deploy. */
export class RabbitMqTransport implements QueueTransport {
  private connection: ChannelModel | null = null
  private channel: ConfirmChannel | null = null

  constructor(private readonly config: RabbitMqTransportConfig) {}

  async connect(): Promise<void> {
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
      await handler({ message, redelivered: raw.fields.redelivered, raw })
    }, { noAck: false })
  }

  ack(delivery: QueueDelivery): void {
    this.requireChannel().ack(delivery.raw as ConsumeMessage)
  }

  nack(delivery: QueueDelivery, requeue: boolean): void {
    this.requireChannel().nack(delivery.raw as ConsumeMessage, false, requeue)
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
    await channel.assertQueue(queue, { durable: true })
    await channel.bindQueue(queue, this.config.exchange, queue)
  }
}
