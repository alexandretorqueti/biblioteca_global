import { describe, expect, it, vi } from 'vitest'
import { InMemoryQueueTransport, OutboxPublisher, createQueueMessage } from '../src/queue/index.js'

describe('OutboxPublisher', () => {
  it('persiste antes de publicar e marca a mensagem como publicada', async () => {
    const transport = new InMemoryQueueTransport()
    const stored = new Map<string, any>()
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO motor_outbox')) {
          stored.set(String(params?.[0]), { message_id: params?.[0], type: params?.[1], task_id: params?.[2], execution_id: params?.[3], payload_json: params?.[4], timestamp: params?.[5], attempt: 0 })
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
    expect(transport.pending('motor.commands')).toBe(1)
  })

  it('mantém pendente quando o transporte falha', async () => {
    const transport = { connect: vi.fn(async () => {}), publish: vi.fn(async () => { throw new Error('broker fora') }) } as any
    const stored: any[] = []
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO motor_outbox')) {
          stored.push({ message_id: params?.[0], type: params?.[1], task_id: params?.[2], execution_id: params?.[3], payload_json: params?.[4], timestamp: params?.[5], attempt: 0, status: 'pending' })
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
  })
})
