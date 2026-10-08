import { describe, expect, it, vi, afterEach } from 'vitest'

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }))

vi.mock('amqplib', () => ({
  default: { connect: connectMock },
}))

import { RabbitMqTransport } from '../src/queue/RabbitMqTransport.js'

function createChannel() {
  return {
    on: vi.fn(),
    assertExchange: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function createConnection(channel: ReturnType<typeof createChannel>) {
  return {
    on: vi.fn(),
    createConfirmChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function createTransport() {
  return new RabbitMqTransport({
    url: 'amqp://unavailable-during-test',
    exchange: 'motor',
    prefetch: 5,
    queue: 'motor.commands',
    retryQueue: 'motor.commands.retry',
    deadLetterQueue: 'motor.commands.dlq',
    retryDelayMs: 30_000,
    initialConnectTimeoutMs: 500,
    initialConnectRetryDelayMs: 100,
    initialConnectMaxRetryDelayMs: 200,
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  connectMock.mockReset()
})

describe('RabbitMqTransport bootstrap', () => {
  it('repete a conexão com backoff e conclui quando o broker fica disponível', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const channel = createChannel()
    const connection = createConnection(channel)
    connectMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(connection)

    const connecting = createTransport().connect()
    await vi.advanceTimersByTimeAsync(300)
    await connecting

    expect(connectMock).toHaveBeenCalledTimes(3)
    expect(connection.createConfirmChannel).toHaveBeenCalledTimes(1)
    expect(channel.assertExchange).toHaveBeenCalledTimes(1)
    expect(channel.prefetch).toHaveBeenCalledTimes(1)
    expect(channel.on).toHaveBeenCalledTimes(2)
    expect(connection.on).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propaga a última falha quando o orçamento de bootstrap se esgota', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = new Error('ECONNREFUSED')
    connectMock.mockRejectedValue(refused)
    const transport = createTransport()

    const connecting = transport.connect()
    const rejection = expect(connecting).rejects.toBe(refused)
    await vi.advanceTimersByTimeAsync(500)

    await rejection
    expect(connectMock).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })
})
