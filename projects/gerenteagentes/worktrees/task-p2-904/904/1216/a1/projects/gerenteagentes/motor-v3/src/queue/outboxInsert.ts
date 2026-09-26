import type { Pool, PoolConnection } from 'mysql2/promise'
import type { QueueMessage } from './QueueMessage.js'

/**
 * Inserção transacional no outbox, reutilizável por qualquer consumidor.
 *
 * Aceita `Pool` ou `PoolConnection` para permitir que a mensagem seja
 * gravada na MESMA transação do fato de negócio (atomicidade fato+evento).
 * O `OutboxPublisher` publica depois sem polling adicional.
 */
export async function insertOutboxMessage(
  queryable: Pool | PoolConnection,
  message: QueueMessage,
  destinationQueue = 'motor.commands',
): Promise<void> {
  await queryable.query(
    `INSERT INTO motor_outbox (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
     VALUES (?,?, ?,?,?,?,NOW(),?,?,'pending',0)`,
    [message.messageId, message.type, destinationQueue, message.taskId, message.executionId,
      JSON.stringify(message.payload), message.correlationId ?? null, message.causationId ?? null],
  )
}
