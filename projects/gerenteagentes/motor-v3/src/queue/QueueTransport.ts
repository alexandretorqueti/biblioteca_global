import type { QueueDelivery, QueueMessage, QueuePublishOptions } from './QueueMessage.js'

export type QueueDeliveryHandler = (delivery: QueueDelivery) => Promise<void>

export interface QueueTransport {
  connect(): Promise<void>
  publish(queue: string, message: QueueMessage, options?: QueuePublishOptions): Promise<void>
  consume(queue: string, handler: QueueDeliveryHandler): Promise<void>
  ack(delivery: QueueDelivery): void
  nack(delivery: QueueDelivery, requeue: boolean): void
  deadLetter(delivery: QueueDelivery, reason: string): Promise<void>
  close(): Promise<void>
}
