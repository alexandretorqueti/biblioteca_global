import { describe, expect, it, vi } from 'vitest'
import { TaskEnqueuedConsumer, ENQUEUED_COMMAND_TYPE } from '../src/coordinator/TaskEnqueuedConsumer.js'
import { createQueueMessage } from '../src/queue/index.js'
import type { OperationLogEntry } from '../src/commands/index.js'

function enqueued(taskId = 'setup-projeto-x') {
  return createQueueMessage({ type: 'TASK_ENQUEUED', taskId, executionId: `exec-${taskId}`, payload: {} })
}

function setup(options: {
  taskRows?: Array<{ id: number; external_id: string | null }>
  pendingResumeTotal?: number
} = {}) {
  const outboxInserts: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('SELECT id, external_id FROM tarefas')) return [options.taskRows ?? [{ id: 9, external_id: 'setup-projeto-x' }], []]
      if (text.includes('COUNT(*)') && text.includes('motor_outbox')) return [[{ total: options.pendingResumeTotal ?? 0 }], []]
      if (text.includes('INSERT INTO motor_outbox')) {
        outboxInserts.push({ sql: text, params: params ?? [] })
        return [{ affectedRows: 1 }, []]
      }
      return [[], []]
    }),
  }
  const entries: OperationLogEntry[] = []
  const logger = { append: vi.fn(async (entry: OperationLogEntry) => { entries.push(entry) }) }
  const events: Array<{ taskId: string; evento: string; payload: unknown }> = []
  const taskEvents = {
    record: vi.fn(async (taskId: string, evento: string, _ator?: string, payload?: unknown) => {
      events.push({ taskId, evento, payload })
    }),
  }
  const consumer = new TaskEnqueuedConsumer(pool as never, logger, taskEvents)
  return { pool, logger, taskEvents, consumer, entries, events, outboxInserts }
}

describe('TaskEnqueuedConsumer', () => {
  it('expõe o tipo de comando consumido (contrato estático com o dispatch)', () => {
    expect(ENQUEUED_COMMAND_TYPE).toBe('TASK_ENQUEUED')
  })

  it('ignora mensagens de outros tipos', async () => {
    const { consumer, pool, outboxInserts } = setup()

    await consumer.handle(createQueueMessage({ type: 'TASK_RESUME_REQUESTED', taskId: 't', executionId: 'e', payload: {} }))

    expect(pool.query).not.toHaveBeenCalled()
    expect(outboxInserts).toHaveLength(0)
  })

  it('consome TASK_ENQUEUED: audita e faz a ponte para TASK_RESUME_REQUESTED no outbox', async () => {
    const { consumer, outboxInserts, events, entries } = setup()
    const message = enqueued()

    await consumer.handle(message)

    expect(outboxInserts).toHaveLength(1)
    const params = outboxInserts[0].params
    expect(params[0]).toBeDefined() // message_id derivado
    expect(params[1]).toBe('TASK_RESUME_REQUESTED')
    expect(params[3]).toBe('setup-projeto-x') // task_id
    expect(String(params[5])).toContain('"reason":"task_enqueued"')
    expect(String(params[5])).toContain(message.messageId) // sourceMessageId p/ rastreio
    expect(events).toHaveLength(1)
    expect(events[0].evento).toBe('task_enqueued')
    expect(events[0].payload).toMatchObject({ bridged: true, bridgeCommand: 'TASK_RESUME_REQUESTED' })
    expect(entries.some(e => e.phase === 'received')).toBe(true)
    expect(entries.some(e => e.phase === 'completed')).toBe(true)
  })

  it('é idempotente: redelivery com resume já pendente no outbox não duplica a ponte', async () => {
    const { consumer, outboxInserts, events, entries } = setup({ pendingResumeTotal: 1 })

    await consumer.handle(enqueued())

    expect(outboxInserts).toHaveLength(0)
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ bridged: false })
    expect(entries.some(e => e.outcome === 'skipped' && String(JSON.stringify(e)).includes('resume_already_pending'))).toBe(true)
  })

  it('rejeita explicitamente quando a tarefa não existe (sem ponte, sem evento)', async () => {
    const { consumer, outboxInserts, events, entries } = setup({ taskRows: [] })

    await consumer.handle(enqueued('task-fantasma'))

    expect(outboxInserts).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(entries.some(e => e.phase === 'rejected' && String(JSON.stringify(e)).includes('task_not_found'))).toBe(true)
  })

  it('falha de auditoria em tarefa_eventos não derruba o consumo (ponte durável preservada)', async () => {
    const { consumer, taskEvents, outboxInserts } = setup()
    vi.mocked(taskEvents.record).mockRejectedValue(new Error('auditoria indisponível'))

    await expect(consumer.handle(enqueued())).resolves.toBeUndefined()

    expect(outboxInserts).toHaveLength(1)
  })

  it('falha na inserção do outbox propaga para o QueueConsumer (retry/DLQ, nunca silencioso)', async () => {
    const { consumer, pool } = setup()
    vi.mocked(pool.query).mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('INSERT INTO motor_outbox')) throw new Error('outbox indisponível')
      if (text.includes('COUNT(*)')) return [[{ total: 0 }], []]
      return [[{ id: 9, external_id: 'setup-projeto-x' }], []]
    })

    await expect(consumer.handle(enqueued())).rejects.toThrow('outbox indisponível')
  })
})
