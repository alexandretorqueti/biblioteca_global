import { describe, expect, it, vi } from 'vitest'
import { SanitizeSessionService, type ConsoleArchiver } from '../src/coordinator/SanitizeSessionService.js'
import type { Pool, PoolConnection } from 'mysql2/promise'

interface QueryRecord { sql: string; params: unknown[] }

/**
 * Fake pool que simula o MySQL para o SanitizeSessionService.
 * Segue o padrão de task-cancel-consumer.test.ts.
 */
function fakePool(options: {
  taskRow?: Record<string, unknown> | null
  blockerRows?: Record<string, unknown>[]
  eventRows?: Record<string, unknown>[]
  transactionFail?: boolean
} = {}) {
  const {
    taskRow = { id: 873, external_id: 'task-p2-873', paused_at: '2026-09-20 10:00:00', terminal_status: '', analysis_execution_id: 'exec-1' },
    blockerRows = [],
    eventRows = [],
    transactionFail = false,
  } = options

  const queries: QueryRecord[] = []
  const connectionQueries: QueryRecord[] = []
  let beginCalled = false
  let commitCalled = false
  let rollbackCalled = false

  const fakeConnection = {
    beginTransaction: vi.fn(async () => { beginCalled = true }),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      connectionQueries.push({ sql: normalized, params: params ?? [] })
      if (transactionFail) throw new Error('Transaction failure simulated')
      if (normalized.startsWith('DELETE FROM task_runtime_facts')) return [{ affectedRows: 1 }]
      if (normalized.startsWith('DELETE FROM bloqueios')) return [{ affectedRows: 1 }]
      if (normalized.startsWith('UPDATE tarefas SET paused_at')) return [{ affectedRows: 1 }]
      if (normalized.startsWith('INSERT INTO tarefa_eventos')) return [{ affectedRows: 1 }]
      return [{ affectedRows: 0 }]
    }),
    commit: vi.fn(async () => { commitCalled = true }),
    rollback: vi.fn(async () => { rollbackCalled = true }),
    release: vi.fn(),
  } as unknown as PoolConnection

  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      queries.push({ sql: normalized, params: params ?? [] })
      // SELECT da tarefa
      if (normalized.startsWith('SELECT t.id, t.external_id, t.paused_at')) {
        return [taskRow ? [taskRow] : []]
      }
      // SELECT de bloqueios
      if (normalized.startsWith('SELECT id FROM bloqueios')) {
        return [blockerRows]
      }
      // SELECT de eventos
      if (normalized.startsWith('SELECT evento, created_at FROM tarefa_eventos')) {
        return [eventRows]
      }
      return [{ affectedRows: 0 }]
    }),
    getConnection: vi.fn(async () => fakeConnection),
  } as unknown as Pool

  return { pool, queries, connectionQueries, fakeConnection, state: { beginCalled: () => beginCalled, commitCalled: () => commitCalled, rollbackCalled: () => rollbackCalled } }
}

function fakeArchiver(archived = true): ConsoleArchiver & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    archiveSession: vi.fn(async (key: string) => {
      calls.push(key)
      return { archived }
    }),
  }
}

describe('SanitizeSessionService', () => {
  describe('deteccao de bloqueio por analise', () => {
    it('detecta bloqueio quando existe bloqueio ativo analysis_failed e terminal_status vazio', async () => {
      const { pool } = fakePool({
        taskRow: { id: 873, external_id: 'task-p2-873', paused_at: null, terminal_status: '', analysis_execution_id: 'exec-1' },
        blockerRows: [{ id: 42 }],
      })
      const service = new SanitizeSessionService(pool)

      const result = await service.execute('task-p2-873')

      expect(result.ok).toBe(true)
      expect(result.analysisReset).toBe(true)
      expect(result.message).toContain('análise resetada')
    })

    it('detecta bloqueio quando existe evento analysis_failed recente sem analysis_completed', async () => {
      const { pool } = fakePool({
        taskRow: { id: 873, external_id: 'task-p2-873', paused_at: null, terminal_status: '', analysis_execution_id: null },
        blockerRows: [],
        eventRows: [{ evento: 'analysis_failed', created_at: '2026-09-24 10:00:00' }],
      })
      const service = new SanitizeSessionService(pool)

      const result = await service.execute('task-p2-873')

      expect(result.ok).toBe(true)
      expect(result.analysisReset).toBe(true)
    })

    it('NAO detecta bloqueio quando ultimo evento e analysis_completed', async () => {
      const { pool } = fakePool({
        taskRow: { id: 873, external_id: 'task-p2-873', paused_at: null, terminal_status: '', analysis_execution_id: null },
        blockerRows: [],
        eventRows: [{ evento: 'analysis_completed', created_at: '2026-09-24 12:00:00' }],
      })
      const service = new SanitizeSessionService(pool)

      const result = await service.execute('task-p2-873')

      expect(result.ok).toBe(true)
      expect(result.analysisReset).toBe(false)
      expect(result.message).toContain('Nenhum bloqueio')
    })

    it('NAO detecta bloqueio quando terminal_status esta preenchido', async () => {
      const { pool } = fakePool({
        taskRow: { id: 873, external_id: 'task-p2-873', paused_at: null, terminal_status: 'completed', analysis_execution_id: null },
        blockerRows: [{ id: 42 }], // tem bloqueio, mas terminal_status preenchido
      })
      const service = new SanitizeSessionService(pool)

      const result = await service.execute('task-p2-873')

      // terminal_status preenchido → condição (a) não se aplica
      // sem evento recente → condição (b) não se aplica
      expect(result.analysisReset).toBe(false)
    })
  })

  describe('reset transacional', () => {
    it('executa DELETE facts, DELETE bloqueios, UPDATE paused_at e INSERT evento em transação', async () => {
      const { pool, connectionQueries, state } = fakePool({
        taskRow: { id: 873, external_id: 'task-p2-873', paused_at: '2026-09-20 10:00:00', terminal_status: '', analysis_execution_id: 'exec-1' },
        blockerRows: [{ id: 42 }],
      })
      const service = new SanitizeSessionService(pool)

      const result = await service.execute('task-p2-873')

      expect(result.analysisReset).toBe(true)
      expect(state.beginCalled()).toBe(true)
      expect(state.commitCalled()).toBe(true)
      expect(state.rollbackCalled()).toBe(false)

      // Verifica as queries na transação
      const deleteFacts = connectionQueries.find(q => q.sql.startsWith('DELETE FROM task_runtime_facts'))
      expect(deleteFacts).toBeDefined()
      expect(deleteFacts!.params).toEqual([873])

      const deleteBlockers = connectionQueries.find(q => q.sql.startsWith('DELETE FROM bloqueios'))
      expect(deleteBlockers).toBeDefined()
      expect(deleteBlockers!.sql).toContain("block_reason = 'analysis_failed'")
      expect(deleteBlockers!.params).toEqual([873])

      const updatePaused = connectionQueries.find(q => q.sql.startsWith('UPDATE tarefas SET paused_at'))
      expect(updatePaused).toBeDefined()
      expect(updatePaused!.params).toEqual([873])

      const insertEvent = connectionQueries.find(q => q.sql.startsWith('INSERT INTO tarefa_eventos'))
      expect(insertEvent).toBeDefined()
      expect(insertEvent!.sql).toContain('analysis_reset')
      // payload contém previousStatus e reason
      const payloadParam = String(insertEvent!.params[0])
      expect(payloadParam).toContain('previousStatus')
      expect(payloadParam).toContain('sanitize_session')
    })

    it('faz rollback quando a transação falha', async () => {
      const { pool, state } = fakePool({
        taskRow: { id: 873, external_id: 'task-p2-873', paused_at: null, terminal_status: '', analysis_execution_id: null },
        blockerRows: [{ id: 42 }],
        transactionFail: true,
      })
      const service = new SanitizeSessionService(pool)

      await expect(service.execute('task-p2-873')).rejects.toThrow('Transaction failure simulated')
      expect(state.rollbackCalled()).toBe(true)
      expect(state.commitCalled()).toBe(false)
    })
  })

  describe('sem bloqueio de analise', () => {
    it('retorna analysisReset: false sem alterar o banco', async () => {
      const { pool, connectionQueries, state } = fakePool({
        taskRow: { id: 100, external_id: 'task-p1-100', paused_at: null, terminal_status: '', analysis_execution_id: null },
        blockerRows: [],
        eventRows: [],
      })
      const service = new SanitizeSessionService(pool)

      const result = await service.execute('task-p1-100')

      expect(result.ok).toBe(true)
      expect(result.analysisReset).toBe(false)
      expect(result.sessionsArchived).toBe(0)
      expect(state.beginCalled()).toBe(false) // sem transação
      expect(connectionQueries).toHaveLength(0) // nenhuma query na connection
    })
  })

  describe('arquivamento de sessao Console', () => {
    it('chama archiveSession e reporta sessionsArchived: 1 quando bem-sucedido', async () => {
      const { pool } = fakePool({
        taskRow: { id: 100, external_id: 'task-p1-100', paused_at: null, terminal_status: '', analysis_execution_id: null },
        blockerRows: [],
        eventRows: [],
      })
      const archiver = fakeArchiver(true)
      const service = new SanitizeSessionService(pool, archiver)

      const result = await service.execute('task-p1-100')

      expect(archiver.calls).toEqual(['task-p1-100'])
      expect(result.sessionsArchived).toBe(1)
    })

    it('erro de arquivamento nao derruba o fluxo', async () => {
      const { pool } = fakePool({
        taskRow: { id: 873, external_id: 'task-p2-873', paused_at: null, terminal_status: '', analysis_execution_id: null },
        blockerRows: [{ id: 42 }],
      })
      const archiver: ConsoleArchiver = {
        archiveSession: vi.fn(async () => { throw new Error('Console unreachable') }),
      }
      const service = new SanitizeSessionService(pool, archiver)

      const result = await service.execute('task-p2-873')

      expect(result.ok).toBe(true)
      expect(result.analysisReset).toBe(true)
      expect(result.sessionsArchived).toBe(0)
    })
  })

  describe('tarefa inexistente', () => {
    it('retorna ok: false com error: not_found', async () => {
      const { pool } = fakePool({ taskRow: null })
      const service = new SanitizeSessionService(pool)

      const result = await service.execute('task-inexistente')

      expect(result.ok).toBe(false)
      expect(result.error).toBe('not_found')
    })
  })
})
