import { describe, expect, it, vi } from 'vitest'
import { QueueConsumer } from '../src/queue/QueueConsumer.js'
import { TerminalFailureRouter } from '../src/queue/TerminalFailureHandler.js'
import { SubtaskTerminalFailureBlocker } from '../src/execution/SubtaskTerminalFailureBlocker.js'
import { SUBTASK_EXECUTION_REQUESTED } from '../src/execution/SubtaskExecutionConsumer.js'
import { SUBTASK_VERIFICATION_REQUESTED } from '../src/execution/SubtaskVerificationConsumer.js'
import type { QueueMessage, QueueDelivery } from '../src/queue/QueueMessage.js'
import type { TerminalFailureHandler } from '../src/queue/TerminalFailureHandler.js'

function makeMessage(overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    messageId: 'msg-1',
    type: 'SUBTASK_EXECUTION_REQUESTED',
    taskId: 'task-p1-939',
    executionId: 'exec-1',
    payload: { subtaskId: 42 },
    timestamp: new Date().toISOString(),
    attempt: overrides.attempt ?? 1,
    ...overrides,
  }
}

function makeDelivery(message: QueueMessage, attempt?: number): QueueDelivery {
  return {
    message,
    redelivered: false,
    attempt: attempt ?? message.attempt,
    raw: {},
  }
}

function mockPool() {
  return {
    execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
    query: vi.fn().mockResolvedValue([[]]),
  } as unknown as import('mysql2/promise').Pool
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

describe('QueueConsumer — TerminalFailureHandler integration', () => {
  it('invoca o TerminalFailureHandler antes da DLQ quando atinge maxAttempts (caminho feliz)', async () => {
    const transport = mockTransport()
    const pool = mockPool()
    const handler = vi.fn().mockResolvedValue(undefined)
    const terminalHandler: TerminalFailureHandler = { handle: handler }

    // Pool: tryClaim retorna claimed=true (affectedRows=1)
    pool.execute.mockResolvedValue([{ affectedRows: 1 }])
    // Pool: getMessage para verificar status
    pool.query.mockResolvedValue([[]])

    const consumer = new QueueConsumer(
      transport,
      async () => { throw new Error('verificação falhou: schema incompatível (work error)') },
      { queue: 'motor.commands', maxAttempts: 3 },
      pool,
      undefined,
      undefined,
      terminalHandler,
    )

    const message = makeMessage({ attempt: 3 })
    const delivery = makeDelivery(message, 3)

    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    await cb(delivery)

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ messageId: 'msg-1' }),
      attempt: 3,
      reason: 'max-attempts-exceeded',
      error: expect.any(Error),
    }))
    expect(transport.deadLetter).toHaveBeenCalledWith(delivery, 'max-attempts-exceeded')
  })

  it('não mascara a falha original quando o TerminalFailureHandler também falha', async () => {
    const transport = mockTransport()
    const pool = mockPool()
    const terminalHandler: TerminalFailureHandler = {
      handle: vi.fn().mockRejectedValue(new Error('bloqueio persistence failed')),
    }

    pool.execute.mockResolvedValue([{ affectedRows: 1 }])
    pool.query.mockResolvedValue([[]])

    const consumer = new QueueConsumer(
      transport,
      async () => { throw new Error('verificação falhou: schema incompatível (work error)') },
      { queue: 'motor.commands', maxAttempts: 3 },
      pool,
      undefined,
      undefined,
      terminalHandler,
    )

    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    const message = makeMessage({ attempt: 3 })
    const delivery = makeDelivery(message, 3)

    // Não deve throw — DLQ ainda acontece apesar da falha do handler
    await expect(cb(delivery)).resolves.toBeUndefined()
    expect(transport.deadLetter).toHaveBeenCalledWith(delivery, 'max-attempts-exceeded')
  })

  it('não invoca TerminalFailureHandler em tentativas intermediárias', async () => {
    const transport = mockTransport()
    const pool = mockPool()
    const handler = vi.fn().mockResolvedValue(undefined)
    const terminalHandler: TerminalFailureHandler = { handle: handler }

    pool.execute.mockResolvedValue([{ affectedRows: 1 }])
    pool.query.mockResolvedValue([[]])

    const consumer = new QueueConsumer(
      transport,
      async () => { throw new Error('transient error') },
      { queue: 'motor.commands', maxAttempts: 3 },
      pool,
      undefined,
      undefined,
      terminalHandler,
    )

    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    const message = makeMessage({ attempt: 1 })
    const delivery = makeDelivery(message, 1)

    await cb(delivery)

    expect(handler).not.toHaveBeenCalled()
    expect(transport.nack).toHaveBeenCalledWith(delivery, false)
    expect(transport.deadLetter).not.toHaveBeenCalled()
  })

  it('funciona sem TerminalFailureHandler (retrocompatível)', async () => {
    const transport = mockTransport()
    const pool = mockPool()

    pool.execute.mockResolvedValue([{ affectedRows: 1 }])
    pool.query.mockResolvedValue([[]])

    const consumer = new QueueConsumer(
      transport,
      async () => { throw new Error('boom') },
      { queue: 'motor.commands', maxAttempts: 3 },
      pool,
      // sem terminalFailureHandler
    )

    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    const message = makeMessage({ attempt: 3 })
    const delivery = makeDelivery(message, 3)

    await cb(delivery)

    expect(transport.deadLetter).toHaveBeenCalledWith(delivery, 'max-attempts-exceeded')
  })

  it('invoca TerminalFailureHandler para mensagem com attempt > maxAttempts (caminho direto)', async () => {
    const transport = mockTransport()
    const pool = mockPool()
    const handler = vi.fn().mockResolvedValue(undefined)
    const terminalHandler: TerminalFailureHandler = { handle: handler }

    pool.execute.mockResolvedValue([{ affectedRows: 1 }])
    pool.query.mockResolvedValue([[]])

    const consumer = new QueueConsumer(
      transport,
      async () => { /* não deve ser chamado */ },
      { queue: 'motor.commands', maxAttempts: 3 },
      pool,
      undefined,
      undefined,
      terminalHandler,
    )

    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    // Mensagem com attempt=4 > maxAttempts=3 — vai direto para DLQ
    const message = makeMessage({ attempt: 4 })
    const delivery = makeDelivery(message, 4)

    await cb(delivery)

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 4,
      reason: 'max-attempts-exceeded',
    }))
    expect(transport.deadLetter).toHaveBeenCalledWith(delivery, 'max-attempts-exceeded')
  })

  it('rotea SUBTASK_VERIFICATION_REQUESTED ao bloqueador terminal antes da DLQ (paridade com execução)', async () => {
    const transport = mockTransport()
    const pool = mockPool()
    const blockerPoolQueries: string[] = []
    const blockerConnection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      query: vi.fn().mockImplementation((sql: string) => {
        blockerPoolQueries.push(sql)
        if (/INSERT INTO bloqueios/i.test(sql)) return [{ affectedRows: 1 }]
        if (/UPDATE subtarefas/i.test(sql)) return [{ affectedRows: 1 }]
        if (/SELECT b\.id, b\.tarefa_id/i.test(sql)) return [[{ id: 7, tarefa_id: 1017 }]]
        return [{ affectedRows: 1 }]
      }),
    }
    const blocker = new SubtaskTerminalFailureBlocker({
      getConnection: vi.fn().mockResolvedValue(blockerConnection),
    } as never)
    // Wiring idêntico ao start.ts: router com os dois tipos de mensagem.
    const router = new TerminalFailureRouter({
      [SUBTASK_EXECUTION_REQUESTED]: blocker.handle,
      [SUBTASK_VERIFICATION_REQUESTED]: blocker.handle,
    })

    pool.execute.mockResolvedValue([{ affectedRows: 1 }])
    pool.query.mockResolvedValue([[]])

    const consumer = new QueueConsumer(
      transport,
      async () => { throw new Error('MigrationJournalIntegrityError: migrations sem tag no journal') },
      { queue: 'motor.commands', maxAttempts: 3 },
      pool,
      undefined,
      undefined,
      router,
    )

    const message = makeMessage({
      messageId: 'msg-verify-1',
      type: SUBTASK_VERIFICATION_REQUESTED,
      attempt: 3,
    })
    const delivery = makeDelivery(message, 3)

    await consumer.start()
    const cb = transport.consume.mock.calls[0][1]
    await cb(delivery)

    // Bloqueio persistido antes da DLQ, com reason dedicado à verificação
    const insert = blockerPoolQueries.find(sql => /INSERT INTO bloqueios/i.test(sql))
    expect(insert).toBeDefined()
    // Subtarefa transiciona de 'verifying' para 'blocked' na mesma transação
    const update = blockerPoolQueries.find(sql => /UPDATE subtarefas/i.test(sql))
    expect(update).toContain("'verifying'")
    // TASK_BLOCKED publicado no outbox motor.monitor
    const outbox = blockerPoolQueries.find(sql => /INSERT INTO motor_outbox/i.test(sql))
    expect(outbox).toBeDefined()
    expect(blockerConnection.commit).toHaveBeenCalled()
    // DLQ ainda acontece após o bloqueio
    expect(transport.deadLetter).toHaveBeenCalledWith(delivery, 'max-attempts-exceeded')
  })

  it('TerminalFailureRouter não invoca handler para tipo não roteado', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    const router = new TerminalFailureRouter({
      [SUBTASK_EXECUTION_REQUESTED]: handler,
      [SUBTASK_VERIFICATION_REQUESTED]: handler,
    })

    await router.handle({
      message: makeMessage({ type: 'DEPLOY_REQUESTED' }),
      attempt: 3,
      reason: 'max-attempts-exceeded',
      error: new Error('boom'),
    })
    expect(handler).not.toHaveBeenCalled()

    await router.handle({
      message: makeMessage({ type: SUBTASK_VERIFICATION_REQUESTED }),
      attempt: 3,
      reason: 'max-attempts-exceeded',
      error: new Error('boom'),
    })
    expect(handler).toHaveBeenCalledOnce()
  })
})
