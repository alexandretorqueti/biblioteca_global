import { describe, expect, it, vi } from 'vitest'
import { MySqlTaskEventRecorder, MySqlAnalysisFailureBlocker } from '../src/coordinator/index.js'
import type { Pool } from 'mysql2/promise'

function fakePool() {
  const queries: { sql: string; params: unknown[] }[] = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params ?? [] })
      return [{ affectedRows: 1 }]
    }),
  } as unknown as Pool
  return { pool, queries }
}

describe('MySqlTaskEventRecorder (incidente 862, item 6)', () => {
  it('registra evento com origem motor para external_id textual', async () => {
    const { pool, queries } = fakePool()
    await new MySqlTaskEventRecorder(pool).record('task-p6-862', 'analysis_failed', 'motor', { error: 'boom' })

    expect(queries).toHaveLength(1)
    expect(queries[0].sql).toContain("INSERT INTO tarefa_eventos")
    expect(queries[0].sql).toContain("'motor'")
    expect(queries[0].sql).toContain('external_id = ?')
    expect(queries[0].params).toEqual(['analysis_failed', 'motor', JSON.stringify({ error: 'boom' }), 'task-p6-862'])
  })

  it('aceita taskId numérico resolvendo por id ou external_id', async () => {
    const { pool, queries } = fakePool()
    await new MySqlTaskEventRecorder(pool).record('862', 'cancelled')

    expect(queries[0].sql).toContain('external_id = ? OR CAST(id AS CHAR) = ?')
    expect(queries[0].params).toEqual(['cancelled', 'motor', 'null', '862', '862'])
  })

  it('trunca evento e ator para os limites das colunas', async () => {
    const { pool, queries } = fakePool()
    await new MySqlTaskEventRecorder(pool).record('t-1', 'x'.repeat(60), 'a'.repeat(300))

    expect((queries[0].params[0] as string).length).toBe(40)
    expect((queries[0].params[1] as string).length).toBe(255)
  })
})

function fakeTxPool(responses: Array<[unknown, unknown]> = []) {
  const queries: { sql: string; params: unknown[] }[] = []
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params ?? [] })
      return responses.shift() ?? [{ affectedRows: 1 }, []]
    }),
  }
  const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool
  return { pool, connection, queries }
}

describe('MySqlAnalysisFailureBlocker (incidente 862, item 2)', () => {
  it('insere bloqueio analysis_failed idempotente na tarefa', async () => {
    const { pool, queries } = fakeTxPool()
    await new MySqlAnalysisFailureBlocker(pool).blockForAnalysisFailure('task-p6-862', {
      executionId: 'exec-analyze-task-p6-862-msg-attempt-3', attempt: 3, error: 'Console indisponível',
    })

    const insert = queries[0]
    expect(insert.sql).toContain('INSERT INTO bloqueios')
    expect(insert.sql).toContain('NOT EXISTS')
    expect(insert.sql).toContain("block_reason = 'analysis_failed'")
    expect(insert.params[0]).toBe('analysis_failed')
    expect(insert.params[1]).toBe('TASK_RESUME_REQUESTED')
    const excerpt = JSON.parse(insert.params[2] as string)
    expect(excerpt).toMatchObject({ attempt: 3, error: 'Console indisponível' })
  })

  it('aceita taskId numérico', async () => {
    const { pool, queries } = fakeTxPool()
    await new MySqlAnalysisFailureBlocker(pool).blockForAnalysisFailure('862', { executionId: 'e', attempt: 3, error: 'x' })

    expect(queries[0].sql).toContain('(t.external_id = ? OR CAST(t.id AS CHAR) = ?)')
    expect(queries[0].params.slice(-2)).toEqual(['862', '862'])
  })

  it('emite TASK_BLOCKED no outbox na mesma transação do bloqueio', async () => {
    const { pool, connection, queries } = fakeTxPool([
      [{ affectedRows: 1 }, []],
      [[{ id: 77, tarefa_id: 862 }], []],
      [{ affectedRows: 1 }, []],
    ])
    await new MySqlAnalysisFailureBlocker(pool).blockForAnalysisFailure('task-p6-862', {
      executionId: 'exec-1', attempt: 1, error: 'modelo indisponível',
    })

    const outbox = queries.find(query => query.sql.includes('INSERT INTO motor_outbox'))
    expect(outbox).toBeDefined()
    expect(outbox!.params[1]).toBe('TASK_BLOCKED')
    expect(outbox!.params[3]).toBe('task-p6-862')
    const payload = JSON.parse(outbox!.params[5] as string)
    expect(payload).toMatchObject({
      blockReason: 'analysis_failed',
      blockCommand: 'TASK_RESUME_REQUESTED',
      blockId: 77,
      databaseTaskId: 862,
    })
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('não emite evento quando o bloqueio já existe (idempotente)', async () => {
    const { pool, connection, queries } = fakeTxPool([[{ affectedRows: 0 }, []]])
    await new MySqlAnalysisFailureBlocker(pool).blockForAnalysisFailure('task-p6-862', {
      executionId: 'exec-1', attempt: 1, error: 'x',
    })

    expect(queries.some(query => query.sql.includes('motor_outbox'))).toBe(false)
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).not.toHaveBeenCalled()
  })

  it('faz rollback e propaga erro quando a transação falha', async () => {
    const { pool, connection } = fakeTxPool()
    ;(connection.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    await expect(
      new MySqlAnalysisFailureBlocker(pool).blockForAnalysisFailure('task-p6-862', {
        executionId: 'exec-1', attempt: 1, error: 'x',
      }),
    ).rejects.toThrow('boom')
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })
})
// @vitest-environment node
