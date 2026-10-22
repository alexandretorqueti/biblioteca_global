import { describe, expect, it, vi } from 'vitest'
import { InMemoryQueueTransport, QueueConsumer, createQueueMessage } from '../src/queue/index.js'
import { MotorActivityGate } from '../src/queue/MotorActivityGate.js'

function createProcessingPool() {
  const records = new Map<string, { status: string; attempt: number }>()
  return {
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      const messageId = String(
        sql.includes("SET status='failed'") || sql.includes("SET status='pending'")
          ? params[params.length - 1]
          : params[0],
      )
      if (sql.includes('INSERT INTO motor_message_processing_state')) {
        if (!records.has(messageId)) records.set(messageId, { status: 'pending', attempt: 1 })
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes("SET status='processing'")) {
        const record = records.get(messageId)
        if (!record || !['pending', 'failed'].includes(record.status)) return [{ affectedRows: 0 }, []]
        record.status = 'processing'
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes("SET status='completed'")) {
        records.get(messageId)!.status = 'completed'
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes("SET status='failed'")) {
        records.get(messageId)!.status = 'failed'
        return [{ affectedRows: 1 }, []]
      }
      if (sql.includes("SET status='pending'")) {
        const record = records.get(messageId)!
        record.status = 'pending'
        record.attempt += 1
        return [{ affectedRows: 1 }, []]
      }
      throw new Error(`SQL inesperado: ${sql}`)
    }),
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      const record = records.get(String(params[0]))
      return [record ? [{ status: record.status }] : [], []]
    }),
  } as any
}

function createConsumer(
  transport: InMemoryQueueTransport,
  handler: (message: any) => Promise<void>,
  maxAttempts = 3,
  pool = createProcessingPool(),
  gate?: MotorActivityGate,
) {
  return new QueueConsumer(transport, handler, { queue: 'motor.commands', maxAttempts }, pool, gate)
}

describe('QueueConsumer', () => {
  it('processa e confirma somente depois do handler concluir', async () => {
    const transport = new InMemoryQueueTransport()
    const handled: string[] = []
    const consumer = createConsumer(transport, async message => {
      handled.push(message.messageId)
    })

    await consumer.start()
    const message = createQueueMessage({
      type: 'TASK_RESUME_REQUESTED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: {},
    })
    await transport.publish('motor.commands', message)

    expect(handled).toEqual([message.messageId])
    expect(transport.pending('motor.commands')).toBe(0)
    await consumer.stop()
  })

  it('envia falha para rejeição sem reprocessar em loop', async () => {
    const transport = new InMemoryQueueTransport()
    const handler = vi.fn(async () => { throw new Error('falha transitória') })
    const consumer = createConsumer(transport, handler)

    await consumer.start()
    await transport.publish('motor.commands', createQueueMessage({
      type: 'TASK_CREATED',
      taskId: 'task-2',
      executionId: 'exec-2',
      payload: {},
    }))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(transport.pending('motor.commands')).toBe(0)
    await consumer.stop()
  })

  it('descarta mensagem repetida depois do primeiro processamento', async () => {
    const transport = new InMemoryQueueTransport()
    const handler = vi.fn(async () => {})
    const consumer = createConsumer(transport, handler)
    const message = createQueueMessage({
      type: 'TASK_ENQUEUED',
      taskId: 'task-3',
      executionId: 'exec-3',
      payload: {},
    })

    await consumer.start()
    await transport.publish('motor.commands', message)
    await transport.publish('motor.commands', message)

    expect(handler).toHaveBeenCalledTimes(1)
    await consumer.stop()
  })

  it('adia redelivery com claim ativo sem consumir tentativas em hot-loop', async () => {
    const transport = new InMemoryQueueTransport()
    const handler = vi.fn(async () => {})
    const pool = createProcessingPool()
    const originalQuery = pool.query
    let statusReads = 0
    pool.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT status FROM motor_message_processing_state')) {
        statusReads += 1
        return statusReads === 1 ? [[{ status: 'processing' }], []] : originalQuery(sql, params ?? [])
      }
      if (sql.includes('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }, []]
      return originalQuery(sql, params ?? [])
    })
    const consumer = createConsumer(transport, handler, 3, pool)
    const message = createQueueMessage({
      type: 'SUBTASK_EXECUTION_REQUESTED', taskId: 'task-restart', executionId: 'exec-restart', payload: { subtaskId: 42 },
    })

    // Simula o claim persistido pelo slot anterior do blue/green.
    await pool.execute(
      'INSERT INTO motor_message_processing_state (message_id, task_id, message_type, status, attempt, created_at) VALUES (?, ?, ?, ?, 1, NOW())',
      [message.messageId, message.taskId, message.type, 'processing'],
    )
    await pool.execute(
      "UPDATE motor_message_processing_state SET status='processing' WHERE message_id=?",
      [message.messageId],
    )

    await consumer.start()
    await transport.publish('motor.commands', message)

    expect(handler).not.toHaveBeenCalled()
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO motor_outbox'),
      expect.arrayContaining([message.type, 'motor.commands', message.taskId, message.executionId]),
    )
    expect(transport.pending('motor.commands')).toBe(0)
    expect(transport.deadLettered()).toHaveLength(0)
    await consumer.stop()
  })

  it('encaminha falha para a DLQ quando atinge o limite', async () => {
    const transport = new InMemoryQueueTransport()
    const handler = vi.fn(async () => { throw new Error('falha permanente') })
    const consumer = createConsumer(transport, handler, 1)

    await consumer.start()
    await transport.publish('motor.commands', createQueueMessage({
      type: 'TASK_CREATED',
      taskId: 'task-dlq',
      executionId: 'exec-dlq',
      payload: {},
    }))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(transport.pending('motor.commands')).toBe(0)
    expect(transport.deadLettered()).toHaveLength(1)
    await consumer.stop()
  })

  it('adia atividade nova sem chamar o handler quando o Motor está inativo', async () => {
    const transport = new InMemoryQueueTransport()
    const handler = vi.fn(async () => {})
    const processingPool = createProcessingPool()
    const originalQuery = processingPool.query
    processingPool.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("chave = 'motor.active'")) return [[{ valor: false }], []]
      if (sql.includes('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }, []]
      return originalQuery(sql, params ?? [])
    })
    const consumer = createConsumer(
      transport,
      handler,
      3,
      processingPool,
      new MotorActivityGate(processingPool),
    )

    await consumer.start()
    await transport.publish('motor.commands', createQueueMessage({
      type: 'SUBTASK_EXECUTION_REQUESTED', taskId: 'task-paused', executionId: 'exec-paused', payload: {},
    }))

    expect(handler).not.toHaveBeenCalled()
    expect(processingPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO motor_outbox'),
      expect.arrayContaining(['SUBTASK_EXECUTION_REQUESTED', 'motor.commands']),
    )
    expect(transport.pending('motor.commands')).toBe(0)
    await consumer.stop()
  })

  it('coalesce adiamentos inativos preservando a identidade e o backoff', async () => {
    const transport = new InMemoryQueueTransport()
    const handler = vi.fn(async () => {})
    const processingPool = createProcessingPool()
    const deferredQueries: Array<{ sql: string; params: unknown[] }> = []
    const originalQuery = processingPool.query
    processingPool.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("chave = 'motor.active'")) return [[{ valor: false }], []]
      if (sql.includes('INSERT INTO motor_outbox')) {
        deferredQueries.push({ sql, params: params ?? [] })
        return [{ affectedRows: 1 }, []]
      }
      return originalQuery(sql, params ?? [])
    })
    const consumer = createConsumer(
      transport,
      handler,
      3,
      processingPool,
      new MotorActivityGate(processingPool),
    )
    const message = createQueueMessage({
      type: 'SUBTASK_EXECUTION_REQUESTED', taskId: 'task-coalesced', executionId: 'exec-coalesced', payload: {},
    })

    await consumer.start()
    await transport.publish('motor.commands', message)
    await transport.publish('motor.commands', message)
    await transport.publish('motor.commands', message)

    expect(deferredQueries).toHaveLength(3)
    expect(deferredQueries.every(({ params }) => params[0] === message.messageId)).toBe(true)
    expect(deferredQueries.every(({ params }) => params[7] === message.messageId)).toBe(true)
    expect(deferredQueries[0].sql).toContain('ON DUPLICATE KEY UPDATE')
    expect(deferredQueries[0].sql).toContain('defer_count = defer_count + 1')
    expect(deferredQueries[0].sql).toContain('LEAST(POW(2, defer_count) * 15, 300)')
    expect(handler).not.toHaveBeenCalled()
    await consumer.stop()
  })

  it('continua processando mensagens de conclusão quando o Motor está inativo', async () => {
    const transport = new InMemoryQueueTransport()
    const handler = vi.fn(async () => {})
    const pool = createProcessingPool()
    const consumer = createConsumer(transport, handler, 3, pool, new MotorActivityGate(pool))

    await consumer.start()
    await transport.publish('motor.commands', createQueueMessage({
      type: 'SUBTASK_EXECUTION_COMPLETED', taskId: 'task-running', executionId: 'exec-running', payload: {},
    }))

    expect(handler).toHaveBeenCalledTimes(1)
    await consumer.stop()
  })
})
// @vitest-environment node
