import { describe, expect, it, vi } from 'vitest'
import { QueueConsumer } from '../src/queue/QueueConsumer.js'
import type { QueueMessage, QueueDelivery } from '../src/queue/QueueMessage.js'
import type { TerminalFailureHandler } from '../src/queue/TerminalFailureHandler.js'

function makeMessage(overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    messageId: 'msg-infra-1',
    type: 'SUBTASK_EXECUTION_REQUESTED',
    taskId: 'task-p1-1048',
    executionId: 'exec-1',
    payload: { subtaskId: 1447 },
    timestamp: new Date().toISOString(),
    attempt: 1,
    ...overrides,
  }
}

function makeDelivery(message: QueueMessage, attempt?: number): QueueDelivery {
  return { message, redelivered: false, attempt: attempt ?? message.attempt, raw: {} }
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

/**
 * Pool mock com roteamento por SQL:
 * - execute (claim/markFailed/incrementAttempt) → affectedRows 1 (claim OK)
 * - SELECT defer_count → valor configurável
 * - demais query (INSERT do outbox) → vazio
 * Registra todas as chamadas para asserções.
 */
function mockPool(deferCount = 0, failOnSelect = false) {
  const queries: string[] = []
  const pool = {
    execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
    query: vi.fn().mockImplementation((sql: string) => {
      queries.push(sql)
      if (sql.includes('SELECT defer_count')) {
        if (failOnSelect) return Promise.reject(new Error('MySQL server has gone away'))
        return Promise.resolve([[{ defer_count: deferCount }]])
      }
      return Promise.resolve([[]])
    }),
  }
  return { pool: pool as unknown as import('mysql2/promise').Pool, queries, mock: pool }
}

function errorWithCode(message: string, code: string): Error {
  const error = new Error(message)
  ;(error as Error & { code: string }).code = code
  return error
}

async function runConsumer(handlerError: Error, opts: { deferCount?: number; failOnSelect?: boolean; maxAttempts?: number } = {}) {
  const transport = mockTransport()
  const { pool, queries, mock } = mockPool(opts.deferCount ?? 0, opts.failOnSelect ?? false)
  const terminalHandle = vi.fn().mockResolvedValue(undefined)
  const terminalHandler: TerminalFailureHandler = { handle: terminalHandle }
  const consumer = new QueueConsumer(
    transport,
    async () => { throw handlerError },
    { queue: 'motor.commands', maxAttempts: opts.maxAttempts ?? 3 },
    pool,
    undefined,
    undefined,
    terminalHandler,
  )
  await consumer.start()
  const cb = transport.consume.mock.calls[0]![1]
  const message = makeMessage()
  const delivery = makeDelivery(message)
  await cb(delivery)
  return { transport, queries, mock, terminalHandle, delivery }
}

describe('QueueConsumer — retry transparente de infra/capacity (taxonomia, melhoria #4)', () => {
  it('erro INFRA: adia via outbox com backoff, ack, NÃO consome attempt, NÃO vai para DLQ nem bloqueia', async () => {
    const { transport, queries, terminalHandle } = await runConsumer(
      errorWithCode('Deadlock found when trying to get lock', 'ER_LOCK_DEADLOCK'),
    )
    expect(transport.ack).toHaveBeenCalled()
    expect(transport.nack).not.toHaveBeenCalled()
    expect(transport.deadLetter).not.toHaveBeenCalled()
    expect(terminalHandle).not.toHaveBeenCalled()
    const insert = queries.find(sql => sql.includes('INSERT INTO motor_outbox'))
    expect(insert).toBeTruthy()
    expect(insert).toContain('defer_count = defer_count + 1')
    expect(insert).toContain('POW(2, defer_count)')
  })

  it('erro de CAPACITY (HTTP 504 do Console): mesmo tratamento transitório', async () => {
    const { transport, queries, terminalHandle } = await runConsumer(new Error('HTTP 504: Gateway Timeout'))
    expect(transport.ack).toHaveBeenCalled()
    expect(transport.deadLetter).not.toHaveBeenCalled()
    expect(terminalHandle).not.toHaveBeenCalled()
    expect(queries.some(sql => sql.includes('INSERT INTO motor_outbox'))).toBe(true)
  })

  it('erro INFRA persistente (defer_count >= MOTOR_TRANSIENT_MAX_DEFERS): DLQ SEM handler terminal (sem bloqueio)', async () => {
    const { transport, terminalHandle } = await runConsumer(
      errorWithCode('connect ECONNREFUSED 127.0.0.1:5672', 'ECONNREFUSED'),
      { deferCount: 40 },
    )
    expect(transport.deadLetter).toHaveBeenCalledWith(expect.anything(), 'infra-retry-exhausted')
    expect(transport.ack).not.toHaveBeenCalled()
    expect(terminalHandle).not.toHaveBeenCalled()
  })

  it('erro de CAPACITY persistente: DLQ com reason capacity-retry-exhausted, sem bloqueio', async () => {
    const { transport, terminalHandle } = await runConsumer(new Error('Service Unavailable'), { deferCount: 99 })
    expect(transport.deadLetter).toHaveBeenCalledWith(expect.anything(), 'capacity-retry-exhausted')
    expect(terminalHandle).not.toHaveBeenCalled()
  })

  it('respeita MOTOR_TRANSIENT_MAX_DEFERS customizado', async () => {
    process.env.MOTOR_TRANSIENT_MAX_DEFERS = '2'
    try {
      const { transport } = await runConsumer(new Error('HTTP 503: Service Unavailable'), { deferCount: 2 })
      expect(transport.deadLetter).toHaveBeenCalledWith(expect.anything(), 'capacity-retry-exhausted')
    } finally {
      delete process.env.MOTOR_TRANSIENT_MAX_DEFERS
    }
  })

  it('erro de WORK mantém o fluxo histórico: nack para retry do broker (abaixo de maxAttempts)', async () => {
    const { transport, queries } = await runConsumer(new Error('3 testes falharam em SubtaskForm.test.tsx'))
    expect(transport.nack).toHaveBeenCalledWith(expect.anything(), false)
    expect(transport.ack).not.toHaveBeenCalled()
    expect(transport.deadLetter).not.toHaveBeenCalled()
    expect(queries.some(sql => sql.includes('INSERT INTO motor_outbox'))).toBe(false)
  })

  it('erro de WORK em maxAttempts segue para DLQ + handler terminal (comportamento pré-existente)', async () => {
    const transport = mockTransport()
    const { pool } = mockPool()
    const terminalHandle = vi.fn().mockResolvedValue(undefined)
    const consumer = new QueueConsumer(
      transport,
      async () => { throw new Error('verificação falhou: schema incompatível') },
      { queue: 'motor.commands', maxAttempts: 3 },
      pool,
      undefined,
      undefined,
      { handle: terminalHandle },
    )
    await consumer.start()
    const cb = transport.consume.mock.calls[0]![1]
    await cb(makeDelivery(makeMessage(), 3))
    expect(terminalHandle).toHaveBeenCalled()
    expect(transport.deadLetter).toHaveBeenCalledWith(expect.anything(), 'max-attempts-exceeded')
  })

  it('falha ao adiar (banco fora junto): nack devolve ao broker como último recurso', async () => {
    const { transport } = await runConsumer(
      errorWithCode('Deadlock found', 'ER_LOCK_DEADLOCK'),
      { failOnSelect: true },
    )
    expect(transport.nack).toHaveBeenCalledWith(expect.anything(), false)
    expect(transport.ack).not.toHaveBeenCalled()
    expect(transport.deadLetter).not.toHaveBeenCalled()
  })
})
