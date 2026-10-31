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

  it('usa block_reason dedicado para SUBTASK_VERIFICATION_REQUESTED', async () => {
    const { pool, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    await blocker.blockForTerminalFailure(makeContext({ messageType: 'SUBTASK_VERIFICATION_REQUESTED' }))

    const insertQuery = queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    expect(insertQuery).toBeDefined()
    expect(insertQuery!.params).toContain('subtask_verification_failed')
    expect(insertQuery!.params).not.toContain('subtask_terminal_failure')

    // block_command e excerpt refletem o tipo real da mensagem
    expect(insertQuery!.params[1]).toBe('motor-v3:terminal:SUBTASK_VERIFICATION_REQUESTED')
    const excerpt = JSON.parse(insertQuery!.params[2] as string)
    expect(excerpt.messageType).toBe('SUBTASK_VERIFICATION_REQUESTED')

    const outboxQuery = queries.find(q => /INSERT INTO motor_outbox/i.test(q.sql))
    expect(outboxQuery).toBeDefined()
    expect(outboxQuery!.params[2]).toBe('motor.monitor')
    const payload = JSON.parse(outboxQuery!.params[5] as string)
    expect(payload.blockReason).toBe('subtask_verification_failed')
  })

  it('mantém block_reason de execução para SUBTASK_EXECUTION_REQUESTED', async () => {
    const { pool, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    await blocker.blockForTerminalFailure(makeContext({ messageType: 'SUBTASK_EXECUTION_REQUESTED' }))

    const insertQuery = queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    expect(insertQuery!.params).toContain('subtask_terminal_failure')
    expect(insertQuery!.params).not.toContain('subtask_verification_failed')
  })

  it('UPDATE de bloqueio cobre subtarefa em status verifying', async () => {
    const { pool, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    await blocker.blockForTerminalFailure(makeContext({ messageType: 'SUBTASK_VERIFICATION_REQUESTED' }))

    const updateQuery = queries.find(q => /UPDATE subtarefas/i.test(q.sql))
    expect(updateQuery).toBeDefined()
    expect(updateQuery!.sql).toContain("'running'")
    expect(updateQuery!.sql).toContain("'pending'")
    expect(updateQuery!.sql).toContain("'verifying'")
    expect(updateQuery!.sql).toContain("SET status='blocked'")
  })

  it('extrai diagnóstico estruturado de MigrationJournalIntegrityError no block_excerpt', async () => {
    const { pool, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    class FakeJournalError extends Error {
      readonly problems = [
        { project: 'gerenteagentes', migration: '0090_algo_novo.sql', expectedTag: '0090' },
        { project: 'outro-projeto', migration: '0011_x.sql', expectedTag: '0011' },
      ]
      readonly inspections = [{ project: 'gerenteagentes', issue: 'journal_missing' }]
      constructor() {
        super('Migrations SQL adicionadas sem a tag correspondente no meta/_journal.json')
        this.name = 'MigrationJournalIntegrityError'
      }
    }

    await blocker.blockForTerminalFailure(makeContext({
      messageType: 'SUBTASK_VERIFICATION_REQUESTED',
      error: new FakeJournalError(),
    }))

    const insertQuery = queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    const excerpt = JSON.parse(insertQuery!.params[2] as string)
    expect(excerpt.errorName).toBe('MigrationJournalIntegrityError')
    expect(excerpt.migrationDiagnostics).toBeDefined()
    expect(excerpt.migrationDiagnostics.errorType).toBe('MigrationJournalIntegrityError')
    expect(excerpt.migrationDiagnostics.journalIssue).toBe('journal_missing')
    expect(excerpt.migrationDiagnostics.orphanedMigrations).toEqual([
      { project: 'gerenteagentes', migration: '0090_algo_novo.sql', expectedTag: '0090' },
      { project: 'outro-projeto', migration: '0011_x.sql', expectedTag: '0011' },
    ])
  })

  it('extrai violações de monotonicidade do journal', async () => {
    const { pool, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    class FakeMonotonicityError extends Error {
      readonly violations = [{
        project: 'gerenteagentes', entryTag: '0086', entryIndex: 86,
        currentWhen: 1000, previousWhen: 1000, previousTag: '0085',
      }]
      constructor() {
        super('Journal de migrations com valores "when" não monotônicos')
        this.name = 'MigrationJournalMonotonicityError'
      }
    }

    await blocker.blockForTerminalFailure(makeContext({
      messageType: 'SUBTASK_VERIFICATION_REQUESTED',
      error: new FakeMonotonicityError(),
    }))

    const insertQuery = queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    const excerpt = JSON.parse(insertQuery!.params[2] as string)
    expect(excerpt.errorName).toBe('MigrationJournalMonotonicityError')
    expect(excerpt.migrationDiagnostics.monotonicityViolations[0].entryTag).toBe('0086')
    expect(excerpt.migrationDiagnostics.monotonicityViolations[0].previousTag).toBe('0085')
  })

  it('não inclui migrationDiagnostics para erros comuns', async () => {
    const { pool, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    await blocker.blockForTerminalFailure(makeContext({
      messageType: 'SUBTASK_VERIFICATION_REQUESTED',
      error: new Error('HTTP 504: Gateway Timeout'),
    }))

    const insertQuery = queries.find(q => /INSERT INTO bloqueios/i.test(q.sql))
    const excerpt = JSON.parse(insertQuery!.params[2] as string)
    expect(excerpt.errorName).toBe('Error')
    expect(excerpt.migrationDiagnostics).toBeUndefined()
  })

  it('redelivery com bloqueio ativo do mesmo motivo não duplica nem reabre (NOT EXISTS + UPDATE condicional)', async () => {
    const { pool, connection, queries } = mockPool()
    // Simula NOT EXISTS ativo: INSERT não inseriu (bloqueio já existe com resolved_at IS NULL)
    connection.query.mockImplementation((sql: string) => {
      if (/INSERT INTO bloqueios/i.test(sql)) return [{ affectedRows: 0 }]
      return [{}]
    })
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)

    await blocker.blockForTerminalFailure(makeContext({ messageType: 'SUBTASK_VERIFICATION_REQUESTED' }))

    // Commit sem UPDATE nem outbox: subtarefa já blocked não é reaberta,
    // bloqueio 'subtask_verification_failed' não é duplicado.
    expect(connection.commit).toHaveBeenCalled()
    expect(queries.find(q => /UPDATE subtarefas/i.test(q.sql))).toBeUndefined()
    expect(queries.find(q => /INSERT INTO motor_outbox/i.test(q.sql))).toBeUndefined()

    // O NOT EXISTS do INSERT usa block_reason + subtarefa ativa (resolved_at IS NULL)
  })

  it('erro de INFRA não gera bloqueio (defesa em profundidade da taxonomia — bloqueio é exceção)', async () => {
    const { pool, connection, queries } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)
    const error = new Error('Deadlock found when trying to get lock') as Error & { code: string }
    error.code = 'ER_LOCK_DEADLOCK'

    await blocker.blockForTerminalFailure(makeContext({ error }))

    expect(connection.beginTransaction).not.toHaveBeenCalled()
    expect(queries.length).toBe(0)
  })

  it('erro de infra embrulhado em cause também é omitido', async () => {
    const { pool, connection } = mockPool()
    const blocker = new SubtaskTerminalFailureBlocker(pool as never)
    const inner = new Error('publish failed') as Error & { code: string }
    inner.code = 'PROTOCOL_CONNECTION_LOST'
    const wrapped = new Error('falha ao concluir verificação', { cause: inner })

    await blocker.blockForTerminalFailure(makeContext({ error: wrapped }))

    expect(connection.beginTransaction).not.toHaveBeenCalled()
  })
})
