import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueueConsumer } from '../src/queue/QueueConsumer.js'
import { MessageProcessingState } from '../src/queue/MessageProcessingState.js'
import type { QueueMessage, QueueDelivery } from '../src/queue/QueueMessage.js'

function makeMessage(overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    messageId: 'msg-heartbeat-1',
    type: 'SUBTASK_EXECUTION_REQUESTED',
    taskId: 'motor-hotspot-merge-deterministico',
    executionId: 'exec-heartbeat-1',
    payload: { subtaskId: 1544, seq: 1 },
    timestamp: new Date().toISOString(),
    attempt: 1,
    ...overrides,
  }
}

function makeDelivery(message: QueueMessage): QueueDelivery {
  return { message, redelivered: false, attempt: message.attempt, raw: {} }
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

interface ExecuteCall { sql: string; params: unknown[] }

function mockPool() {
  const calls: ExecuteCall[] = []
  const pool = {
    execute: vi.fn(async (sql: unknown, params?: unknown) => {
      calls.push({ sql: String(sql), params: (params ?? []) as unknown[] })
      return [{ affectedRows: 1 }]
    }),
    query: vi.fn(async () => [[{ status: 'processing' }]]),
  }
  return { pool, calls }
}

const isRenew = (call: ExecuteCall): boolean => /SET timeout_at = DATE_ADD/i.test(call.sql)

describe('QueueConsumer — heartbeat do claim de processamento (incidente bloqueios 3500/3501)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete process.env.MOTOR_MESSAGE_CLAIM_HEARTBEAT_SECONDS
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.MOTOR_MESSAGE_CLAIM_HEARTBEAT_SECONDS
  })

  it('renova timeout_at periodicamente enquanto o handler está em execução', async () => {
    const transport = mockTransport()
    const { pool, calls } = mockPool()
    let resolveHandler: () => void = () => {}
    const handlerFinished = new Promise<void>(resolve => { resolveHandler = resolve })

    const consumer = new QueueConsumer(
      transport,
      () => handlerFinished,
      { queue: 'motor.commands', maxAttempts: 3 },
      pool as never,
    )
    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    const processing = cb(makeDelivery(makeMessage()))
    // Garante que o claim e o registro do heartbeat aconteceram.
    await vi.advanceTimersByTimeAsync(0)

    // Intervalo padrão: min(60, max(5, floor(300/3))) = 60s.
    await vi.advanceTimersByTimeAsync(61_000)
    const renews = calls.filter(isRenew)
    expect(renews.length).toBe(1)
    // A renovação só toca claim vivo: o UPDATE é condicional em status='processing'.
    expect(renews[0].sql).toMatch(/status='processing'/i)
    expect(renews[0].params).toEqual(['msg-heartbeat-1'])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter(isRenew).length).toBe(2)

    resolveHandler()
    await processing

    // Handler concluído: o heartbeat para e não renova mais o claim.
    const renewCountAfterCompletion = calls.filter(isRenew).length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls.filter(isRenew).length).toBe(renewCountAfterCompletion)

    // Fluxo normal preservado: completed + ack.
    expect(calls.some(call => /status='completed'/i.test(call.sql))).toBe(true)
    expect(transport.ack).toHaveBeenCalledTimes(1)
  })

  it('interrompe o heartbeat quando o handler falha', async () => {
    const transport = mockTransport()
    const { pool, calls } = mockPool()
    let rejectHandler: (error: Error) => void = () => {}
    const handlerFailed = new Promise<void>((_, reject) => { rejectHandler = reject })

    const consumer = new QueueConsumer(
      transport,
      () => handlerFailed,
      { queue: 'motor.commands', maxAttempts: 3 },
      pool as never,
    )
    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    const processing = cb(makeDelivery(makeMessage({ messageId: 'msg-heartbeat-2' })))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(calls.filter(isRenew).length).toBe(1)

    rejectHandler(new Error('falha de trabalho'))
    await processing

    const renewCountAfterFailure = calls.filter(isRenew).length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(calls.filter(isRenew).length).toBe(renewCountAfterFailure)
  })

  it('honra MOTOR_MESSAGE_CLAIM_HEARTBEAT_SECONDS respeitando o piso de segurança', async () => {
    process.env.MOTOR_MESSAGE_CLAIM_HEARTBEAT_SECONDS = '10'
    const transport = mockTransport()
    const { pool, calls } = mockPool()
    let resolveHandler: () => void = () => {}
    const handlerFinished = new Promise<void>(resolve => { resolveHandler = resolve })

    const consumer = new QueueConsumer(
      transport,
      () => handlerFinished,
      { queue: 'motor.commands', maxAttempts: 3 },
      pool as never,
    )
    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    const processing = cb(makeDelivery(makeMessage({ messageId: 'msg-heartbeat-3' })))
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(11_000)
    expect(calls.filter(isRenew).length).toBe(1)

    resolveHandler()
    await processing
  })
})

describe('MessageProcessingState.renewTimeout', () => {
  it('retorna false sem ressuscitar claim que deixou de estar processing', async () => {
    const pool = {
      execute: vi.fn(async () => [{ affectedRows: 0 }]),
      query: vi.fn(),
    }
    const state = new MessageProcessingState(pool as never)
    await expect(state.renewTimeout('msg-gone')).resolves.toBe(false)
    const sql = String(pool.execute.mock.calls[0][0])
    expect(sql).toMatch(/UPDATE motor_message_processing_state/i)
    expect(sql).toMatch(/status='processing'/i)
  })

  it('retorna true quando o claim vivo foi renovado', async () => {
    const pool = {
      execute: vi.fn(async () => [{ affectedRows: 1 }]),
      query: vi.fn(),
    }
    const state = new MessageProcessingState(pool as never)
    await expect(state.renewTimeout('msg-live')).resolves.toBe(true)
  })
})
