import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import { createQueueMessage } from '../src/queue/index.js'

describe('governança de falhas em deploy e fila', () => {
  it('roteia falha terminal de deploy pelo catálogo antes da conclusão idempotente', async () => {
    const completeBatch = vi.fn(async () => ['task-863'])
    const handleFailure = vi.fn(async () => ({ governed: true }))
    const consumer = new DeployConsumer(
      { completeBatch } as never,
      {} as never,
      {} as never,
      { append: async () => {} },
      undefined,
      undefined,
      undefined,
      undefined,
      { handleFailure } as never,
    )
    const message = createQueueMessage({
      type: 'DEPLOY_BATCH_RESULT_RECEIVED',
      taskId: 'task-863',
      executionId: 'deploy-863',
      payload: { batchId: 'batch-863', status: 'failed' },
    })

    await consumer.handle(message)

    expect(handleFailure).toHaveBeenCalledWith(
      'deploy_failed',
      expect.objectContaining({ taskId: 'task-863', executionId: 'deploy-863' }),
      expect.objectContaining({ code: 'DEPLOY_FAILED' }),
    )
    expect(completeBatch).toHaveBeenCalledTimes(1)
  })

  it('mantém DLQ como efeito terminal mesmo quando governança falha', async () => {
    const deadLetter = vi.fn(async () => {})
    const transport = {
      connect: async () => {},
      consume: async (queue: string, handler: (delivery: unknown) => Promise<void>) => { void queue; void handler },
      close: async () => {},
      ack: vi.fn(),
      nack: vi.fn(),
      deadLetter,
    }
    const pool = {
      execute: vi.fn(async () => [{ affectedRows: 1 }, []]),
      query: vi.fn(async () => [[], []]),
    } as unknown as Pool
    const { QueueConsumer } = await import('../src/queue/QueueConsumer.js')
    const handler = { handleFailure: vi.fn(async () => { throw new Error('catálogo indisponível') }) }
    const consumer = new QueueConsumer(transport as never, async () => { throw new Error('falha permanente') }, { queue: 'q', maxAttempts: 1 }, pool, handler as never)
    await consumer.start()

    const delivery = {
      message: createQueueMessage({ type: 'TASK_FAILED', taskId: 'task-864', executionId: 'exec-864', payload: {} }),
      attempt: 1,
      redelivered: false,
      raw: {},
    }
    await (consumer as unknown as { handle(value: unknown): Promise<void> }).handle(delivery)

    expect(handler.handleFailure).toHaveBeenCalledTimes(1)
    expect(deadLetter).toHaveBeenCalledWith(delivery, 'max-attempts-exceeded')
  })
})
