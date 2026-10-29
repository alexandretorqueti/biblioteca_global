import { describe, expect, it, vi } from 'vitest'
import { QueueConsumer } from '../src/queue/QueueConsumer.js'
import type { QueueMessage, QueueDelivery } from '../src/queue/QueueMessage.js'

function makeMessage(overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    messageId: 'msg-lease-1',
    type: 'TASK_RESUME_REQUESTED',
    taskId: 'task-p2-1047',
    executionId: 'exec-lease-1',
    payload: { reason: 'external_resolution' },
    timestamp: new Date().toISOString(),
    attempt: 1,
    ...overrides,
  }
}

function makeDelivery(message: QueueMessage, attempt?: number): QueueDelivery {
  return { message, redelivered: true, attempt: attempt ?? message.attempt, raw: {} }
}

function mockTransport() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn(),
    nack: vi.fn(),
    deadLetter: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  }
}

describe('QueueConsumer — deferUntilProcessingLeaseExpires (incidente task-p2-1047)', () => {
  it('rearma a linha do outbox via upsert em vez de colidir com motor_outbox_logical_key_unique', async () => {
    const transport = mockTransport()
    const pool = {
      execute: vi.fn(),
      query: vi.fn(),
    }
    // tryClaim: INSERT do state (ok) + UPDATE condicional → affectedRows 0
    pool.execute.mockResolvedValue([{ affectedRows: 0 }])
    // 1ª query: SELECT status → 'processing' (lease ativo) → alreadyProcessing
    // 2ª query: INSERT diferido no motor_outbox
    pool.query
      .mockResolvedValueOnce([[{ status: 'processing' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])

    const consumer = new QueueConsumer(
      transport,
      async () => { throw new Error('handler não deve rodar com lease ativo') },
      { queue: 'motor.commands', maxAttempts: 3 },
      pool as never,
    )

    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    await cb(makeDelivery(makeMessage()))

    const calls = pool.query.mock.calls as unknown[][]
    const insertCall = calls.find(call => String(call[0]).includes('INSERT INTO motor_outbox'))
    expect(insertCall).toBeDefined()
    const sql = String(insertCall![0])
    // O correlation_id derivado da origem colide com a linha original do
    // outbox no unique (type, task_id, correlation_id); o upsert precisa
    // rearmar a linha existente em vez de lançar errno 1062.
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/i)
    expect(sql).toContain('message_id = deferred_row.message_id')
    expect(sql).toContain('execution_id = deferred_row.execution_id')
    expect(sql).toContain('timestamp = deferred_row.timestamp')
    expect(sql).toMatch(/status = 'pending'/)
    expect(sql).toContain('published_at = NULL')
    expect(sql).toContain('defer_count = defer_count + 1')
    // correlation/causation preservam a cadeia da mensagem original
    const params = insertCall![1] as unknown[]
    expect(params[7]).toBe('msg-lease-1') // correlation_id = fallback messageId
    expect(params[8]).toBe('msg-lease-1') // causation_id
    // entrega duplicada confirmada (sem hot-loop no broker)
    expect(transport.ack).toHaveBeenCalledTimes(1)
    expect(transport.nack).not.toHaveBeenCalled()
    expect(transport.deadLetter).not.toHaveBeenCalled()
  })
})
