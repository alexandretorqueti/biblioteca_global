import { describe, expect, it, vi } from 'vitest'
import { InMemoryQueueTransport, OutboxPublisher, createQueueMessage } from '../src/queue/index.js'

describe('OutboxPublisher', () => {
  it('recupera claims abandonados antes de processar o outbox no início', async () => {
    const transport = new InMemoryQueueTransport()
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE motor_message_processing_state')) return [{ affectedRows: 2 }, []]
        if (sql.includes('SELECT message_id')) return [[], []]
        throw new Error(`SQL inesperado: ${sql}`)
      }),
    } as any
    const publisher = new OutboxPublisher(pool, transport, 'motor.commands')

    await publisher.start()

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("state.status = 'pending'"))
    await publisher.stop()
  })

  it('persiste antes de publicar e marca a mensagem como publicada', async () => {
    const transport = new InMemoryQueueTransport()
    const stored = new Map<string, any>()
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('UPDATE motor_message_processing_state')) return [{ affectedRows: 0 }, []]
        if (sql.includes('INSERT INTO motor_outbox')) {
          stored.set(String(params?.[0]), { message_id: params?.[0], type: params?.[1], destination_queue: params?.[2], task_id: params?.[3], execution_id: params?.[4], payload_json: params?.[5], timestamp: params?.[6], attempt: 0 })
          return [{ affectedRows: 1 }, []]
        }
        if (sql.includes('SELECT message_id')) return [[...stored.values()].filter(row => row.status !== 'published'), []]
        if (sql.includes("SET status = 'published'")) {
          const row = stored.get(String(params?.[0]))
          if (row) row.status = 'published'
          return [{ affectedRows: 1 }, []]
        }
        throw new Error(`SQL inesperado: ${sql}`)
      }),
    } as any
    const publisher = new OutboxPublisher(pool, transport, 'motor.commands')
    await publisher.start()
    const message = createQueueMessage({ type: 'TASK_RESUME_REQUESTED', taskId: 'task-1', executionId: 'exec-1', payload: { origem: 'teste' } })

    await publisher.enqueue(message)

    expect(stored.get(message.messageId)?.status).toBe('published')
    expect(stored.get(message.messageId)?.timestamp).toBe(message.timestamp.slice(0, 19).replace('T', ' '))
    expect(transport.pending('motor.commands')).toBe(1)
    await publisher.stop()
  })

  it('mantém pendente quando o transporte falha', async () => {
    const transport = { connect: vi.fn(async () => {}), publish: vi.fn(async () => { throw new Error('broker fora') }) } as any
    const stored: any[] = []
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('UPDATE motor_message_processing_state')) return [{ affectedRows: 0 }, []]
        if (sql.includes('INSERT INTO motor_outbox')) {
          stored.push({ message_id: params?.[0], type: params?.[1], destination_queue: params?.[2], task_id: params?.[3], execution_id: params?.[4], payload_json: params?.[5], timestamp: params?.[6], attempt: 0, status: 'pending' })
          return [{ affectedRows: 1 }, []]
        }
        if (sql.includes('SELECT message_id')) return [stored, []]
        if (sql.includes('SET attempt')) return [{ affectedRows: 1 }, []]
        throw new Error(`SQL inesperado: ${sql}`)
      }),
    } as any
    const publisher = new OutboxPublisher(pool, transport, 'motor.commands')
    await publisher.start()
    await publisher.enqueue(createQueueMessage({ type: 'TASK_CREATED', taskId: 'task-2', executionId: 'exec-2', payload: {} }))

    expect(stored[0].status).toBe('pending')
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('last_error'), expect.any(Array))
    await publisher.stop()
  })

  it('publica somente mensagens destinadas à fila dedicada', async () => {
    const transport = new InMemoryQueueTransport()
    const stored = [{
      message_id: 'gate-1', type: 'TEST_RUN_REQUESTED', destination_queue: 'motor.test-gates',
      task_id: 'task-1', execution_id: 'exec-1', payload_json: '{}', timestamp: new Date(), attempt: 0,
    }]
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('UPDATE motor_message_processing_state')) return [{ affectedRows: 0 }, []]
        if (sql.includes('SELECT message_id')) return [stored, []]
        if (sql.includes("SET status = 'published'")) return [{ affectedRows: 1 }, []]
        throw new Error(`SQL inesperado: ${sql}`)
      }),
    } as any
    const publisher = new OutboxPublisher(pool, transport, 'motor.test-gates', 'motor.test-gates')
    await publisher.start()
    expect(transport.pending('motor.test-gates')).toBe(1)
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('destination_queue = ?'), ['motor.test-gates'])
    await publisher.stop()
  })
})
