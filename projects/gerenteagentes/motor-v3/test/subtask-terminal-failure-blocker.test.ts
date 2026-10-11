import { describe, expect, it, vi } from 'vitest'
import { SubtaskTerminalFailureBlocker } from '../src/execution/SubtaskTerminalFailureBlocker.js'
import type { TerminalFailureContext } from '../src/queue/TerminalFailureHandler.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

function makeContext(overrides: Partial<{
  subtaskId: number
  taskId: string
  executionId: string
  attempt: number
  reason: string
  error: Error
  messageType: string
}> = {}): TerminalFailureContext {
  const message: QueueMessage = {
    messageId: 'msg-terminal-1',
    type: overrides.messageType ?? 'SUBTASK_EXECUTION_REQUESTED',
    taskId: overrides.taskId ?? 'task-p1-939',
    executionId: overrides.executionId ?? 'exec-123',
    payload: { subtaskId: overrides.subtaskId ?? 42 },
    timestamp: new Date().toISOString(),
    attempt: overrides.attempt ?? 3,
  }
  return {
    message,
    attempt: overrides.attempt ?? 3,
    reason: overrides.reason ?? 'max-attempts-exceeded',
    error: overrides.error ?? new Error('HTTP 504: Gateway Timeout on sessions.describe'),
  }
}

function mockPool() {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      // INSERT INTO bloqueios
      if (/INSERT INTO bloqueios/i.test(sql)) {
        return [{ affectedRows: 1 }]
      }
      // UPDATE subtarefas
      if (/UPDATE subtarefas/i.test(sql)) {
        return [{ affectedRows: 1 }]
      }
      // SELECT bloqueios (para TASK_BLOCKED)
      if (/SELECT b\.id, b\.tarefa_id/i.test(sql)) {
        return [[{ id: 99, tarefa_id: 640 }]]
      }
      // INSERT INTO motor_outbox
      if (/INSERT INTO motor_outbox/i.test(sql)) {
        return [{ affectedRows: 1 }]
      }
      return [{}]
    }),
  }
  const pool = {
    getConnection: vi.fn().mockResolvedValue(connection),
  }
  return { pool, connection, queries }
}

describe('SubtaskTerminalFailureBlocker', () => {
  it('cria bloqueio idempotente com diagnóstico acionável', async () => {
    const { pool, connection, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    const context = makeContext()
    await blocker.blockForTerminalFailure(context)

    expect(connection.beginTransaction).toHaveBeenCalled()
    expect(connection.commit).toHaveBeenCalled()
    expect(connection.release).toHaveBeenCalled()

    // INSERT bloqueio com NOT EXISTS
    const insertQuery = queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    expect(insertQuery).toBeDefined()
    expect(insertQuery!.params).toContain('subtask_terminal_failure')
    expect(insertQuery!.params).toContain(42) // subtaskId

    // UPDATE subtarefas para blocked
    const updateQuery = queries.find(q => /UPDATE subtarefas/i.test(q.sql))
    expect(updateQuery).toBeDefined()
    expect(updateQuery!.params).toContain(42)

    // TASK_BLOCKED emitido via outbox
    const outboxQuery = queries.find(q => /INSERT INTO motor_outbox/i.test(q.sql))
    expect(outboxQuery).toBeDefined()
  })

  it('é idempotente: não duplica bloqueio quando já existe', async () => {
    const { pool, connection, queries } = mockPool()
    // Simula affectedRows=0 (bloqueio já existe)
    connection.query.mockImplementation((sql: string) => {
      if (/INSERT INTO bloqueios/i.test(sql)) {
        return [{ affectedRows: 0 }]
      }
      return [{}]
    })
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    await blocker.blockForTerminalFailure(makeContext())

    expect(connection.commit).toHaveBeenCalled()
    // Não deve fazer UPDATE nem outbox
    const updateQuery = queries.find(q => /UPDATE subtarefas.*SET.*status.*blocked/i.test(q.sql))
    expect(updateQuery).toBeUndefined()
    const outboxQuery = queries.find(q => /INSERT INTO motor_outbox/i.test(q.sql))
    expect(outboxQuery).toBeUndefined()
  })

  it('ignora mensagens sem subtaskId válido', async () => {
    const { pool, connection } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    const context = makeContext({ subtaskId: 0 })
    await blocker.blockForTerminalFailure(context)

    expect(connection.beginTransaction).not.toHaveBeenCalled()
  })

  it('trunca error e reason para caber nos limites do schema', async () => {
    const { pool, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    const longError = new Error('x'.repeat(5000))
    const longReason = 'y'.repeat(1000)
    const context = makeContext({ error: longError, reason: longReason })

    await blocker.blockForTerminalFailure(context)

    const insertQuery = queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    expect(insertQuery).toBeDefined()
    // block_excerpt é JSON com reason (max 500) + error (max 1800)
    const excerpt = JSON.parse(insertQuery!.params[2] as string)
    expect(excerpt.reason.length).toBeLessThanOrEqual(500)
    expect(excerpt.error.length).toBeLessThanOrEqual(1800)
  })

  it('preserva executionId e attempt no diagnóstico', async () => {
    const { pool, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    const context = makeContext({ executionId: 'exec-abc-123', attempt: 5 })
    await blocker.blockForTerminalFailure(context)

    const insertQuery = queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    const excerpt = JSON.parse(insertQuery!.params[2] as string)
    expect(excerpt.executionId).toBe('exec-abc-123')
    expect(excerpt.attempt).toBe(5)
    expect(excerpt.messageType).toBe('SUBTASK_EXECUTION_REQUESTED')
    expect(excerpt.messageId).toBe('msg-terminal-1')
  })

  it('faz rollback e propaga erro quando query falha', async () => {
    const { pool, connection } = mockPool()
    connection.query.mockRejectedValueOnce(new Error('DB connection lost'))
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    await expect(blocker.blockForTerminalFailure(makeContext())).rejects.toThrow('DB connection lost')
    expect(connection.rollback).toHaveBeenCalled()
    expect(connection.release).toHaveBeenCalled()
  })

  it('handler é compatível com TerminalFailureMessageHandler', async () => {
    const { pool } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    // O handle deve ser uma função que aceita TerminalFailureContext
    expect(typeof blocker.handle).toBe('function')
    await expect(blocker.handle(makeContext())).resolves.toBeUndefined()
  })
})
