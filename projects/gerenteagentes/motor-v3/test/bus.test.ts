import { describe, it, expect, beforeEach } from 'vitest'
import { MessageBus, EventLogger, type Message } from '../src/bus/index.js'

function makeMessage(type: string, taskId = 'task-1', subtaskId?: number): Message {
  return {
    type,
    taskId,
    subtaskId,
    executionId: `exec-${taskId}-${subtaskId ?? 'task'}`,
    payload: {},
    timestamp: new Date().toISOString(),
  }
}

describe('MessageBus', () => {
  let bus: MessageBus

  beforeEach(() => {
    bus = new MessageBus()
  })

  it('should call handler for matching message type', async () => {
    const received: Message[] = []
    bus.on('TEST_EVENT', (msg) => { received.push(msg) })

    const msg = makeMessage('TEST_EVENT')
    await bus.send(msg)

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(msg)
  })

  it('should not call handler for non-matching type', async () => {
    const received: Message[] = []
    bus.on('OTHER_EVENT', (msg) => { received.push(msg) })

    await bus.send(makeMessage('TEST_EVENT'))

    expect(received).toHaveLength(0)
  })

  it('should call multiple handlers for the same type', async () => {
    const r1: Message[] = []
    const r2: Message[] = []
    bus.on('TEST_EVENT', (msg) => { r1.push(msg) })
    bus.on('TEST_EVENT', (msg) => { r2.push(msg) })

    await bus.send(makeMessage('TEST_EVENT'))

    expect(r1).toHaveLength(1)
    expect(r2).toHaveLength(1)
  })

  it('should continue calling other handlers when one throws', async () => {
    const r1: Message[] = []
    const r2: Message[] = []
    bus.on('TEST_EVENT', () => { throw new Error('boom') })
    bus.on('TEST_EVENT', (msg) => { r2.push(msg) })

    await bus.send(makeMessage('TEST_EVENT'))

    // r1 would have been the first handler but it threw; r2 should still run
    expect(r2).toHaveLength(1)
  })

  it('should remove handler with off()', async () => {
    const received: Message[] = []
    const handler = (msg: Message) => { received.push(msg) }
    bus.on('TEST_EVENT', handler)

    await bus.send(makeMessage('TEST_EVENT'))
    expect(received).toHaveLength(1)

    bus.off('TEST_EVENT', handler)
    await bus.send(makeMessage('TEST_EVENT'))
    expect(received).toHaveLength(1) // no new message
  })

  it('should remove handler via unsubscribe function', async () => {
    const received: Message[] = []
    const unsubscribe = bus.on('TEST_EVENT', (msg) => { received.push(msg) })

    await bus.send(makeMessage('TEST_EVENT'))
    expect(received).toHaveLength(1)

    unsubscribe()
    await bus.send(makeMessage('TEST_EVENT'))
    expect(received).toHaveLength(1)
  })

  it('should call topic handlers by taskId+subtaskId', async () => {
    const received: Message[] = []
    bus.subscribe('task-1:5', (msg) => { received.push(msg) })

    await bus.send(makeMessage('EVENT_BUILD_OK', 'task-1', 5))
    expect(received).toHaveLength(1)

    // Different subtask should not trigger
    await bus.send(makeMessage('EVENT_BUILD_OK', 'task-1', 6))
    expect(received).toHaveLength(1)
  })

  it('should call task-level topic handlers (no subtaskId)', async () => {
    const received: Message[] = []
    bus.subscribe('task-1:task', (msg) => { received.push(msg) })

    await bus.send(makeMessage('EVENT_ANALYSIS_DONE', 'task-1'))
    expect(received).toHaveLength(1)
  })

  it('emit() should wrap with EVENT_ prefix and timestamp', async () => {
    const received: Message[] = []
    bus.on('EVENT_BUILD_OK', (msg) => { received.push(msg) })

    await bus.emit('BUILD_OK', {
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { exitCode: 0 },
    })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('EVENT_BUILD_OK')
    expect(received[0].timestamp).toBeDefined()
    expect(received[0].payload.exitCode).toBe(0)
  })

  it('should call middlewares in order', async () => {
    const log: string[] = []
    bus.use({ name: 'first', onMessage: (dir) => { log.push(`first:${dir}`) } })
    bus.use({ name: 'second', onMessage: (dir) => { log.push(`second:${dir}`) } })

    bus.on('TEST', () => {})
    await bus.send(makeMessage('TEST'))

    // pre-dispatch: first sent, second sent
    // post-dispatch: first received, second received
    expect(log).toEqual(['first:sent', 'second:sent', 'first:received', 'second:received'])
  })

  it('debug() should return handler counts', () => {
    bus.on('A', () => {})
    bus.on('A', () => {})
    bus.on('B', () => {})
    bus.subscribe('task-1:1', () => {})

    const debug = bus.debug()
    expect(debug.typeHandlers.A).toBe(2)
    expect(debug.typeHandlers.B).toBe(1)
    expect(debug.topicHandlers['task-1:1']).toBe(1)
  })
})

describe('EventLogger', () => {
  let bus: MessageBus
  let logger: EventLogger

  beforeEach(() => {
    bus = new MessageBus()
    logger = new EventLogger([]) // sem stdout sink para não poluir teste
    bus.use(logger)
  })

  it('should log sent and received entries', async () => {
    bus.on('TEST', () => {})
    await bus.send(makeMessage('TEST', 'task-42', 7))

    const entries = logger.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0].direction).toBe('sent')
    expect(entries[1].direction).toBe('received')
    expect(entries[0].messageType).toBe('TEST')
    expect(entries[0].tarefaId).toBe('task-42')
    expect(entries[0].subtarefaId).toBe(7)
  })

  it('byDirection should filter correctly', async () => {
    bus.on('TEST', () => {})
    await bus.send(makeMessage('TEST'))
    await bus.send(makeMessage('TEST'))

    expect(logger.byDirection('sent')).toHaveLength(2)
    expect(logger.byDirection('received')).toHaveLength(2)
    expect(logger.byDirection('event')).toHaveLength(0)
  })

  it('byType should filter correctly', async () => {
    bus.on('A', () => {})
    bus.on('B', () => {})
    await bus.send(makeMessage('A'))
    await bus.send(makeMessage('B'))
    await bus.send(makeMessage('A'))

    expect(logger.byType('A')).toHaveLength(4) // 2 sent + 2 received
    expect(logger.byType('B')).toHaveLength(2)
  })

  it('byTask should filter correctly', async () => {
    bus.on('TEST', () => {})
    await bus.send(makeMessage('TEST', 'task-1'))
    await bus.send(makeMessage('TEST', 'task-2'))
    await bus.send(makeMessage('TEST', 'task-1'))

    expect(logger.byTask('task-1')).toHaveLength(4) // 2 messages × 2 directions
    expect(logger.byTask('task-2')).toHaveLength(2)
  })

  it('clear should remove all entries', async () => {
    bus.on('TEST', () => {})
    await bus.send(makeMessage('TEST'))
    expect(logger.getEntries().length).toBeGreaterThan(0)

    logger.clear()
    expect(logger.getEntries()).toHaveLength(0)
  })

  it('should extract model and generation from payload', async () => {
    bus.on('TEST', () => {})
    await bus.send({
      type: 'TEST',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { model: 'qwen3-coder:30b', generation: 3 },
      timestamp: new Date().toISOString(),
      correlationId: 'abc123456789',
    })

    const entries = logger.getEntries()
    expect(entries[0].model).toBe('qwen3-coder:30b')
    expect(entries[0].generation).toBe(3)
    expect(entries[0].correlationId).toBe('abc123456789')
  })
})
