import type { Pool } from 'mysql2/promise'
import { createQueueMessage, type QueueMessage } from '../queue/QueueMessage.js'
import { insertOutboxDurable } from '../queue/outboxInsert.js'

export const DEPLOY_BATCH_RESULT_RECEIVED = 'DEPLOY_BATCH_RESULT_RECEIVED'

export interface DeployResultFallbackInput {
  batchId: string
  status: 'success' | 'failed'
  pool: Pool
}

export type DeployResultFallbackOutcome =
  | { ok: true; message: QueueMessage }
  | { ok: false; error: string }

/**
 * Callback honesto de resultado de deploy quando o slot não é líder da fila
 * (outboxPublisher null — boot/follower): persiste a mensagem direto no
 * outbox via `insertOutboxDurable`, caminho durável independente de
 * liderança. O líder publica a linha pendente normalmente.
 *
 * Nunca despacha in-memory sem consumidor: falha de persistência retorna
 * `ok:false` para o endpoint responder 503 (retryable) — jamais 202/ok
 * sem mensagem durável.
 */
export async function dispatchDeployResultFallback(
  input: DeployResultFallbackInput,
): Promise<DeployResultFallbackOutcome> {
  try {
    const message = await insertOutboxDurable(input.pool, {
      type: DEPLOY_BATCH_RESULT_RECEIVED,
      taskId: 'system',
      executionId: `deploy-result-${input.batchId}`,
      payload: { batchId: input.batchId, status: input.status },
    })
    return { ok: true, message }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Mensagem do callback no formato exato do dispatchCommand líder (paridade). */
export function buildDeployResultMessage(batchId: string, status: 'success' | 'failed'): QueueMessage {
  return createQueueMessage({
    type: DEPLOY_BATCH_RESULT_RECEIVED,
    taskId: 'system',
    executionId: `deploy-result-${batchId}`,
    payload: { batchId, status },
  })
}
