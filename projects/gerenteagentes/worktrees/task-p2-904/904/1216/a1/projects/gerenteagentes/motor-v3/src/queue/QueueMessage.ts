/**
 * Contrato da mensagem que atravessa a fila durável.
 *
 * O MessageBus continua recebendo mensagens internas do processo. Este
 * contrato representa somente a fronteira externa (RabbitMQ ou transporte de
 * teste) e, por isso, precisa ser serializável e idempotente.
 */
import { randomUUID } from 'node:crypto'
export interface QueueMessage<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  messageId: string
  type: string
  taskId: string
  executionId: string
  payload: TPayload
  timestamp: string
  correlationId?: string
  causationId?: string
  attempt: number
}

export interface QueueDelivery {
  message: QueueMessage
  redelivered: boolean
  /** Número de retornos pela fila de retry, quando fornecido pelo broker. */
  attempt?: number
  raw: unknown
}

export interface QueuePublishOptions {
  messageId?: string
  correlationId?: string
  causationId?: string
  persistent?: boolean
}

export function createQueueMessage(
  input: Omit<QueueMessage, 'messageId' | 'timestamp' | 'attempt'> & Partial<Pick<QueueMessage, 'messageId' | 'timestamp' | 'attempt'>>,
): QueueMessage {
  return {
    ...input,
    messageId: input.messageId ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    attempt: input.attempt ?? 1,
  }
}
