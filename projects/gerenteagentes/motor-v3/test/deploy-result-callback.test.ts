import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import {
  buildDeployResultMessage,
  dispatchDeployResultFallback,
} from '../src/deploy/DeployResultCallback.js'
import { createQueueMessage } from '../src/queue/QueueMessage.js'

interface QueryRecord { sql: string; params: unknown[] }

function fakePool(options: { fail?: boolean } = {}) {
  const queries: QueryRecord[] = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      queries.push({ sql: normalized, params: params ?? [] })
      if (options.fail) throw new Error('connection refused')
      return [{ affectedRows: 1 }]
    }),
  } as unknown as Pool
  return { pool, queries }
}

describe('callback honesto — DEPLOY_BATCH_RESULT_RECEIVED', () => {
  it('slot não-líder: persiste via insertOutboxMessage no pool (caminho durável)', async () => {
    const { pool, queries } = fakePool()

    const result = await dispatchDeployResultFallback({ batchId: 'deploy-c00303a3', status: 'success', pool })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(queries).toHaveLength(1)
    const insert = queries[0]!
    expect(insert.sql).toContain('INSERT INTO motor_outbox')
    expect(insert.sql).toContain("'pending',0")
    expect(insert.params[0]).toBe(result.message.messageId)
    expect(insert.params[1]).toBe('DEPLOY_BATCH_RESULT_RECEIVED')
    expect(insert.params[2]).toBe('motor.commands')
    expect(insert.params[3]).toBe('system')
    expect(insert.params[4]).toBe('deploy-result-deploy-c00303a3')
    expect(JSON.parse(String(insert.params[5]))).toEqual({ batchId: 'deploy-c00303a3', status: 'success' })
  })

  it('falha de persistência: retorna ok:false (endpoint deve responder 503, nunca ok:true)', async () => {
    const { pool } = fakePool({ fail: true })

    const result = await dispatchDeployResultFallback({ batchId: 'batch-x', status: 'failed', pool })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('connection refused')
  })

  it('paridade com o caminho líder: mesma mensagem que createQueueMessage do dispatchCommand', async () => {
    const { pool } = fakePool()

    const result = await dispatchDeployResultFallback({ batchId: 'batch-p', status: 'failed', pool })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Réplica exata do que start.ts/dispatchCommand monta no slot líder.
    const leaderLike = createQueueMessage({
      type: 'DEPLOY_BATCH_RESULT_RECEIVED',
      taskId: 'system',
      executionId: 'deploy-result-batch-p',
      payload: { batchId: 'batch-p', status: 'failed' },
    })
    expect(result.message).toMatchObject({
      type: leaderLike.type,
      taskId: leaderLike.taskId,
      executionId: leaderLike.executionId,
      payload: leaderLike.payload,
    })
    expect(buildDeployResultMessage('batch-p', 'failed')).toMatchObject({
      type: 'DEPLOY_BATCH_RESULT_RECEIVED',
      taskId: 'system',
      executionId: 'deploy-result-batch-p',
      payload: { batchId: 'batch-p', status: 'failed' },
    })
    // Campos duráveis obrigatórios para o outbox.
    expect(typeof result.message.messageId).toBe('string')
    expect(result.message.messageId.length).toBeGreaterThan(10)
    expect(typeof result.message.timestamp).toBe('string')
    expect(result.message.attempt).toBe(1)
  })
})
