import type { QueueDelivery, QueueMessage, QueuePublishOptions } from './QueueMessage.js'
import type { QueueDeliveryHandler, QueueTransport } from './QueueTransport.js'

/** Transporte determinístico para testes e desenvolvimento sem broker. */
export class InMemoryQueueTransport implements QueueTransport {
  private readonly queues = new Map<string, QueueDelivery[]>()
  private readonly consumers = new Map<string, QueueDeliveryHandler>()
  private connected = false

  async connect(): Promise<void> {
    this.connected = true
  }

  async publish(queue: string, message: QueueMessage, _options?: QueuePublishOptions): Promise<void> {
    if (!this.connected) throw new Error('InMemoryQueueTransport não conectado')
    const deliveries = this.queues.get(queue) ?? []
    deliveries.push({ message, redelivered: false, raw: message })
    this.queues.set(queue, deliveries)
    await this.drain(queue)
  }

  async consume(queue: string, handler: QueueDeliveryHandler): Promise<void> {
    if (!this.connected) throw new Error('InMemoryQueueTransport não conectado')
    this.consumers.set(queue, handler)
    await this.drain(queue)
  }

  ack(delivery: QueueDelivery): void {
    this.removeDelivery(delivery)
  }

  nack(delivery: QueueDelivery, requeue: boolean): void {
    if (!requeue) {
      this.removeDelivery(delivery)
      return
    }
    delivery.redelivered = true
  }

  async close(): Promise<void> {
    this.connected = false
    this.consumers.clear()
  }

  pending(queue: string): number {
    return this.queues.get(queue)?.length ?? 0
  }

  private async drain(queue: string): Promise<void> {
    const handler = this.consumers.get(queue)
    const deliveries = this.queues.get(queue)
    if (!handler || !deliveries) return

    while (deliveries.length > 0) {
      const delivery = deliveries[0]!
      await handler(delivery)
      if (deliveries[0] === delivery) return
    }
  }

  private removeDelivery(delivery: QueueDelivery): void {
    for (const deliveries of this.queues.values()) {
      const index = deliveries.indexOf(delivery)
      if (index >= 0) {
        deliveries.splice(index, 1)
        return
      }
    }
  }
}
