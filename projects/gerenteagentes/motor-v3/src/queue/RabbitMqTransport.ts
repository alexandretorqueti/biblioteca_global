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
  reconnectDelayMs?: number
  maxReconnectAttempts?: number
}

/** Adaptador RabbitMQ com retry por TTL e fila de mensagens mortas. */
export class RabbitMqTransport implements QueueTransport {
  private connection: ChannelModel | null = null
  private channel: ConfirmChannel | null = null
  private reconnecting = false
  private reconnectAttempts = 0
  private consumers: Array<{ queue: string; handler: QueueDeliveryHandler }> = []

  constructor(private readonly config: RabbitMqTransportConfig) {}

  async connect(): Promise<void> {
    if (this.channel) return
    this.connection = await amqp.connect(this.config.url)
    this.channel = await this.connection.createConfirmChannel()
    
    // Listener de erro no canal — não crasha o motor, tenta reconectar
    this.channel.on('error', (error) => {
      console.error('[RabbitMqTransport] Canal fechado com erro:', error.message)
      this.scheduleReconnect()
    })

    // Listener de fechamento do canal
    this.channel.on('close', () => {
      console.warn('[RabbitMqTransport] Canal fechado pelo servidor')
      this.scheduleReconnect()
    })

    // Listener de erro na conexão
    this.connection.on('error', (error) => {
      console.error('[RabbitMqTransport] Conexão RabbitMQ com erro:', error.message)
    })

    // Listener de fechamento da conexão
    this.connection.on('close', () => {
      console.warn('[RabbitMqTransport] Conexão RabbitMQ fechada')
      this.scheduleReconnect()
    })

    await this.channel.assertExchange(this.config.exchange, 'direct', { durable: true })
    await this.channel.prefetch(this.config.prefetch)
    this.reconnectAttempts = 0 // Reset após conexão bem-sucedida
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
    // Salva consumer para reconectar depois se necessário
    this.consumers.push({ queue, handler })
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
      try {
        await handler({
          message: { ...message, attempt: Math.max(message.attempt || 1, attempt) },
          attempt,
          redelivered: raw.fields.redelivered,
          raw,
        })
      } catch (error) {
        console.error('[RabbitMqTransport] erro no handler da mensagem:', error)
        // Não propaga erro — handler é responsável por fazer nack/deadLetter
      }
    }, { noAck: false })
  }

  ack(delivery: QueueDelivery): void {
    try {
      this.requireChannel().ack(delivery.raw as ConsumeMessage)
    } catch (error) {
      console.error('[RabbitMqTransport] erro ao fazer ack:', error)
      // Canal pode estar fechado — não propaga erro
    }
  }

  nack(delivery: QueueDelivery, requeue: boolean): void {
    try {
      this.requireChannel().nack(delivery.raw as ConsumeMessage, false, requeue)
    } catch (error) {
      console.error('[RabbitMqTransport] erro ao fazer nack:', error)
      // Canal pode estar fechado — não propaga erro
    }
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

  /**
   * Agenda reconexão automática após falha do canal.
   * Usa exponential backoff para evitar spam de reconexões.
   */
  private scheduleReconnect(): void {
    if (this.reconnecting) return
    const maxAttempts = this.config.maxReconnectAttempts ?? 10
    if (this.reconnectAttempts >= maxAttempts) {
      console.error(`[RabbitMqTransport] máximo de tentativas de reconexão atingido (${maxAttempts})`)
      return
    }
    
    this.reconnecting = true
    this.reconnectAttempts++
    const delay = this.config.reconnectDelayMs ?? 5000
    const backoff = Math.min(delay * Math.pow(2, this.reconnectAttempts - 1), 60000)
    
    console.warn(`[RabbitMqTransport] reconectando em ${backoff}ms (tentativa ${this.reconnectAttempts}/${maxAttempts})`)
    
    setTimeout(async () => {
      try {
        console.log('[RabbitMqTransport] iniciando reconexão...')
        await this.close()
        await this.connect()
        
        // Re-registra todos os consumers
        for (const consumer of this.consumers) {
          console.log(`[RabbitMqTransport] re-registrando consumer na fila ${consumer.queue}`)
          await this.consume(consumer.queue, consumer.handler)
        }
        
        console.log('[RabbitMqTransport] reconexão bem-sucedida')
      } catch (error) {
        console.error('[RabbitMqTransport] falha na reconexão:', error)
        this.reconnecting = false
        this.scheduleReconnect() // Tenta novamente
      } finally {
        this.reconnecting = false
      }
    }, backoff)
  }
}
