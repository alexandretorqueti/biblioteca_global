import { describe, expect, it, vi } from 'vitest'
import { InMemoryQueueTransport, QueueConsumer } from '../src/queue/index.js'
import { TASK_BLOCKED_EVENT_TYPE, createTaskBlockedMessage } from '../src/monitor/index.js'

function createProcessingPool() {
  const records = new Map<string, { status: string }>()
  return {
    execute: vi.fn(async (sql: string, params: unknown[]) => {
      const messageId = String(
        sql.includes("SET status='failed'") || sql.includes("SET status='pending'")
          ? params[params.length - 1]
          : params[0],
      )
      if (sql.includes('INSERT INTO motor_message_processing_state')) {
        if (!records.has(messageId)) records.set(messageId, { status: 'pending' })
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
      throw new Error(`SQL inesperado: ${sql}`)
    }),
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      const record = records.get(String(params[0]))
      return [record ? [{ status: record.status }] : [], []]
    }),
  } as any
}

describe('wiring da fila motor.monitor', () => {
  it('encaminha TASK_BLOCKED para MonitorResolutionConsumer.handle', async () => {
    const transport = new InMemoryQueueTransport()
    const monitorResolutionConsumer = { handle: vi.fn(async () => {}) }
    const consumer = new QueueConsumer(
      transport,
      message => monitorResolutionConsumer.handle(message),
      { queue: 'motor.monitor', maxAttempts: 3 },
      createProcessingPool(),
    )
    const message = createTaskBlockedMessage({
      taskId: 'task-p2-949',
      executionId: 'monitor-block-1',
      payload: { blockId: 1288, blockReason: 'deploy_failed', databaseTaskId: 949 },
    })

    expect(message.type).toBe(TASK_BLOCKED_EVENT_TYPE)
    await consumer.start()
    await transport.publish('motor.monitor', message)

    expect(monitorResolutionConsumer.handle).toHaveBeenCalledOnce()
    expect(monitorResolutionConsumer.handle).toHaveBeenCalledWith(message)
    expect(transport.pending('motor.monitor')).toBe(0)
    await consumer.stop()
  })
})
