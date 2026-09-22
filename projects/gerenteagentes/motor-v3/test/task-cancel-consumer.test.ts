import { describe, expect, it, vi } from 'vitest'
import { TaskCancelConsumer, CANCEL_ACTION_CODE, CANCEL_COMMAND_CODE } from '../src/coordinator/index.js'
import type { CommandPolicyRepository, OperationLogEntry, OperationLogger } from '../src/commands/index.js'
import type { TaskEventSink } from '../src/coordinator/index.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'
import type { Pool } from 'mysql2/promise'

interface QueryRecord { sql: string; params: unknown[] }

function fakePool(taskRow: Record<string, unknown> | null) {
  const queries: QueryRecord[] = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      queries.push({ sql: normalized, params: params ?? [] })
      if (normalized.startsWith('SELECT t.id, t.external_id, f.terminal_status')) {
        return [taskRow ? [taskRow] : []]
      }
      if (normalized.startsWith('UPDATE task_runtime_facts')) return [{ affectedRows: 1 }]
      if (normalized.startsWith('UPDATE bloqueios')) return [{ affectedRows: 2 }]
      if (normalized.startsWith('INSERT INTO task_runtime_facts')) return [{ affectedRows: 1 }]
      return [{ affectedRows: 0 }]
    }),
  } as unknown as Pool
  return { pool, queries }
}

function policies(): CommandPolicyRepository {
  return {
    findByMessageType: vi.fn(async () => ({
      command: { code: CANCEL_COMMAND_CODE, active: true, version: 1 },
      policies: [{ code: 'P04_CANCEL_IF_NOT_TERMINAL', priority: 100, conditions: ['task_not_terminal'], actionCode: CANCEL_ACTION_CODE, active: true, version: 1 }],
    })),
  }
}

function logger() {
  const entries: OperationLogEntry[] = []
  const instance: OperationLogger = { append: vi.fn(async entry => { entries.push(entry) }) }
  return { instance, entries }
}

function recorder() {
  const events: { taskId: string; evento: string; ator?: string; payload?: Record<string, unknown> | null }[] = []
  const sink: TaskEventSink = { record: vi.fn(async (taskId, evento, ator, payload) => { events.push({ taskId, evento, ator, payload }) }) }
  return { sink, events }
}

function cancelMessage(payload: Record<string, unknown> = {}): QueueMessage {
  return createQueueMessage({ type: 'TASK_CANCEL_REQUESTED', taskId: 'task-p6-862', executionId: 'task-p6-862', payload })
}

const cancelableTask = { id: 862, external_id: 'task-p6-862', terminal_status: null }

describe('TaskCancelConsumer (incidente 862, item 1)', () => {
  it('cancela tarefa não terminal: libera claim, resolve bloqueios, marca cancelled e registra evento', async () => {
    const { pool, queries } = fakePool(cancelableTask)
    const { instance, entries } = logger()
    const { sink, events } = recorder()
    const consumer = new TaskCancelConsumer(pool, instance, policies(), sink)

    await consumer.handle(cancelMessage({ ator: 'alexandre', motivo: 'Tarefa obsoleta' }))

    const releaseClaim = queries.find(q => q.sql.startsWith('UPDATE task_runtime_facts'))
    expect(releaseClaim?.sql).toContain('analysis_started_at = NULL')
    expect(releaseClaim?.params).toEqual([862])

    const resolveBlockers = queries.find(q => q.sql.startsWith('UPDATE bloqueios'))
    expect(resolveBlockers?.sql).toContain('resolved_at IS NULL')

    const markCancelled = queries.find(q => q.sql.startsWith('INSERT INTO task_runtime_facts'))
    expect(markCancelled?.sql).toContain("'cancelled'")
    expect(markCancelled?.sql).toContain('ON DUPLICATE KEY UPDATE')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ taskId: 'task-p6-862', evento: 'cancelled', ator: 'alexandre' })
    expect(events[0].payload).toMatchObject({ motivo: 'Tarefa obsoleta' })

    expect(entries.map(e => e.phase)).toEqual(['received', 'decision', 'action', 'primitive', 'primitive', 'primitive', 'primitive', 'completed'])
    expect(entries.filter(e => e.phase === 'primitive').map(e => e.primitiveCode)).toEqual([
      'release_analysis_claim', 'resolve_task_blockers', 'mark_task_cancelled', 'record_task_event',
    ])
    const sequences = entries.map(e => e.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('rejeita tarefa já terminal via política P04 sem tocar no banco', async () => {
    const { pool, queries } = fakePool({ ...cancelableTask, terminal_status: 'completed' })
    const { instance, entries } = logger()
    const { sink, events } = recorder()
    const consumer = new TaskCancelConsumer(pool, instance, policies(), sink)

    await consumer.handle(cancelMessage())

    expect(queries.filter(q => q.sql.startsWith('UPDATE') || q.sql.startsWith('INSERT'))).toHaveLength(0)
    expect(events).toHaveLength(0)
    expect(entries.some(e => e.phase === 'rejected' && e.reasonCode === 'task_terminal')).toBe(true)
  })

  it('rejeita tarefa inexistente com task_not_found', async () => {
    const { pool } = fakePool(null)
    const { instance, entries } = logger()
    const consumer = new TaskCancelConsumer(pool, instance, policies())

    await consumer.handle(cancelMessage())

    expect(entries.some(e => e.phase === 'rejected' && e.reasonCode === 'task_not_found')).toBe(true)
  })

  it('sem catálogo configurado, cancela não terminal e rejeita terminal internamente', async () => {
    const { pool, queries } = fakePool(cancelableTask)
    const consumer = new TaskCancelConsumer(pool)
    await consumer.handle(cancelMessage())
    expect(queries.some(q => q.sql.startsWith('INSERT INTO task_runtime_facts'))).toBe(true)

    const terminal = fakePool({ ...cancelableTask, terminal_status: 'cancelled' })
    const consumer2 = new TaskCancelConsumer(terminal.pool)
    await consumer2.handle(cancelMessage())
    expect(terminal.queries.filter(q => q.sql.startsWith('UPDATE') || q.sql.startsWith('INSERT'))).toHaveLength(0)
  })

  it('usa ator padrão motor e motivo nulo quando o payload vem vazio', async () => {
    const { pool } = fakePool(cancelableTask)
    const { sink, events } = recorder()
    const consumer = new TaskCancelConsumer(pool, undefined, policies(), sink)

    await consumer.handle(cancelMessage({}))

    expect(events[0]).toMatchObject({ evento: 'cancelled', ator: 'motor' })
    expect(events[0].payload).toMatchObject({ motivo: null })
  })

  it('ignora outros tipos de mensagem', async () => {
    const { pool, queries } = fakePool(cancelableTask)
    const consumer = new TaskCancelConsumer(pool, undefined, policies())

    await consumer.handle(createQueueMessage({ type: 'TASK_RESUME_REQUESTED', taskId: 'task-p6-862', executionId: 'x', payload: {} }))

    expect(queries).toHaveLength(0)
  })
})
// @vitest-environment node
