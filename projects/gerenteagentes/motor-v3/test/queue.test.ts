import { describe, expect, it, vi } from 'vitest'
import { InMemoryQueueTransport, QueueConsumer, createQueueMessage } from '../src/queue/index.js'

describe('QueueConsumer', () => {
  it('processa e confirma somente depois do handler concluir', async () => {
    const transport = new InMemoryQueueTransport()
    const handled: string[] = []
    const consumer = new QueueConsumer(transport, async message => {
      handled.push(message.messageId)
    }, { queue: 'motor.commands', maxAttempts: 3 })

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
    const consumer = new QueueConsumer(transport, handler, { queue: 'motor.commands', maxAttempts: 3 })

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
    const consumer = new QueueConsumer(transport, handler, { queue: 'motor.commands', maxAttempts: 3 })
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
})
