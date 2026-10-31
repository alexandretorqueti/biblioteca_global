import { describe, expect, it, vi, afterEach } from 'vitest'

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }))

vi.mock('amqplib', () => ({
  default: { connect: connectMock },
}))

import { RabbitMqTransport } from '../src/queue/RabbitMqTransport.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

function rawMessage(message: unknown, deaths = [{ count: 2 }, { count: 1 }]) {
  return {
    content: Buffer.from(typeof message === 'string' ? message : JSON.stringify(message), 'utf8'),
    fields: { deliveryTag: 1, redelivered: false, exchange: 'motor', routingKey: 'q', consumerTag: 'c' },
    properties: { headers: { 'x-death': deaths }, contentType: 'application/json' },
  }
}

function sampleMessage(id: string): QueueMessage {
  return {
    messageId: id, type: 'TASK_BLOCKED', taskId: 'task-p2-1', executionId: 'e',
    payload: { blockId: 9 }, timestamp: new Date().toISOString(), attempt: 3,
  }
}

function createProbeChannel(getResults: Array<unknown>) {
  return {
    get: vi.fn(async () => getResults.shift() ?? false),
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function createMainChannel() {
  return {
    on: vi.fn(),
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue(undefined),
    prefetch: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

async function connectedTransport(probe: ReturnType<typeof createProbeChannel>) {
  const main = createMainChannel()
  const connection = {
    on: vi.fn(),
    createConfirmChannel: vi.fn().mockResolvedValue(main),
    createChannel: vi.fn().mockResolvedValue(probe),
    close: vi.fn().mockResolvedValue(undefined),
  }
  connectMock.mockResolvedValueOnce(connection)
  const transport = new RabbitMqTransport({
    url: 'amqp://test', exchange: 'motor', prefetch: 5,
    queue: 'motor.commands', retryQueue: 'motor.commands.retry',
    deadLetterQueue: 'motor.commands.dlq', retryDelayMs: 1000,
  })
  await transport.connect()
  return { transport, probe, main }
}

afterEach(() => {
  vi.restoreAllMocks()
  connectMock.mockReset()
})

describe('RabbitMqTransport.visitDeadLetters', () => {
  it('ack remove a mensagem da fila e soma x-death para o visitor', async () => {
    const probe = createProbeChannel([rawMessage(sampleMessage('m1')), false])
    const { transport } = await connectedTransport(probe)
    const seen: number[] = []
    const outcome = await transport.visitDeadLetters('motor.commands.dlq', 10, async visit => {
      seen.push(visit.deathCount)
      return 'ack'
    })
    expect(outcome).toEqual({ acked: 1, retried: 0 })
    expect(seen).toEqual([3])
    expect(probe.ack).toHaveBeenCalledTimes(1)
    expect(probe.nack).not.toHaveBeenCalled()
    expect(probe.close).toHaveBeenCalled()
  })

  it("verdict 'retry' devolve com requeue e interrompe o ciclo", async () => {
    const probe = createProbeChannel([rawMessage(sampleMessage('m1')), rawMessage(sampleMessage('m2'))])
    const { transport } = await connectedTransport(probe)
    const outcome = await transport.visitDeadLetters('motor.commands.dlq', 10, async () => 'retry')
    expect(outcome).toEqual({ acked: 0, retried: 1 })
    expect(probe.nack).toHaveBeenCalledWith(expect.anything(), false, true)
    expect(probe.get).toHaveBeenCalledTimes(1)
  })

  it('visitor que lança é tratado como retry (mensagem nunca é perdida)', async () => {
    const probe = createProbeChannel([rawMessage(sampleMessage('m1'))])
    const { transport } = await connectedTransport(probe)
    const outcome = await transport.visitDeadLetters('motor.commands.dlq', 10, async () => {
      throw new Error('db caiu')
    })
    expect(outcome).toEqual({ acked: 0, retried: 1 })
    expect(probe.nack).toHaveBeenCalledWith(expect.anything(), false, true)
  })

  it('JSON ilegível volta para a fila e encerra o ciclo sem descartar', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const probe = createProbeChannel([rawMessage('{invalido'), rawMessage(sampleMessage('m2'))])
    const { transport } = await connectedTransport(probe)
    const outcome = await transport.visitDeadLetters('motor.commands.dlq', 10, async () => 'ack')
    expect(outcome).toEqual({ acked: 0, retried: 1 })
    expect(probe.nack).toHaveBeenCalledWith(expect.anything(), false, true)
    expect(probe.get).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalled()
  })

  it('respeita o limite max e fila vazia retorna zerado', async () => {
    const probe = createProbeChannel([rawMessage(sampleMessage('m1')), rawMessage(sampleMessage('m2')), rawMessage(sampleMessage('m3'))])
    const { transport } = await connectedTransport(probe)
    const outcome = await transport.visitDeadLetters('motor.commands.dlq', 2, async () => 'ack')
    expect(outcome).toEqual({ acked: 2, retried: 0 })
    expect(probe.get).toHaveBeenCalledTimes(2)
  })
})
