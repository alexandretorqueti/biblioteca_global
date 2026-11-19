import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MessageProcessingClaimReconciler } from '../src/queue/index.js'
import { MessageProcessingState } from '../src/queue/MessageProcessingState.js'

function fakePool(rows: unknown[] = [], affectedRows = 1) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      if (String(sql).includes('SELECT state.message_id')) return [rows, []]
      if (String(sql).includes('SELECT status FROM')) return [[{ status: 'processing' }], []]
      return [{ affectedRows }, []]
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      return [{ affectedRows }, []]
    }),
  } as unknown as Pool
  return { pool, queries }
}

describe('MessageProcessingClaimReconciler', () => {
  it('marca claim expirado como failed e republica o outbox', async () => {
    const env = fakePool([{ message_id: 'msg-1', outbox_message_id: 'msg-1' }])
    const reconciler = new MessageProcessingClaimReconciler(env.pool, { processingTimeoutSeconds: 300 })

    await expect(reconciler.reconcile()).resolves.toEqual({ failed: 1, requeued: 1, withoutOutbox: 0 })
    expect(env.queries[0]?.sql).toContain("state.status = 'processing'")
    expect(env.queries[0]?.sql).toContain('state.timeout_at < NOW()')
    expect(env.queries[1]?.sql).toContain("status = 'failed'")
    expect(env.queries[2]?.sql).toContain("status = 'pending'")
    expect(env.queries[2]?.sql).toContain('published_at = NULL')
  })

  it('não toca claim vivo e terminaliza claim expirado sem outbox', async () => {
    const live = fakePool([])
    await expect(new MessageProcessingClaimReconciler(live.pool).reconcile()).resolves.toEqual({ failed: 0, requeued: 0, withoutOutbox: 0 })
    expect(live.queries).toHaveLength(1)

    const missing = fakePool([{ message_id: 'msg-missing', outbox_message_id: null }])
    await expect(new MessageProcessingClaimReconciler(missing.pool).reconcile()).resolves.toEqual({ failed: 1, requeued: 0, withoutOutbox: 1 })
    expect(missing.queries).toHaveLength(2)
    expect(missing.queries[1]?.sql).toContain("status = 'failed'")
  })

  it('inicia e para o reconciliador periódico sem timers duplicados', () => {
    vi.useFakeTimers()
    try {
      const env = fakePool([])
      const reconciler = new MessageProcessingClaimReconciler(env.pool, { intervalMs: 1_000 })
      reconciler.start()
      reconciler.start()
      expect(vi.getTimerCount()).toBe(1)
      reconciler.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MessageProcessingState timeout_at', () => {
  it('preenche timeout_at no claim e mantém fallback de reclaim legado', async () => {
    const env = fakePool([], 1)
    const state = new MessageProcessingState(env.pool, 300)
    await expect(state.tryClaim('msg-1', 'COMMAND', 'task-1')).resolves.toEqual({
      claimed: true, alreadyCompleted: false, alreadyProcessing: false,
    })
    const claim = env.queries.find(query => query.sql.includes("SET status='processing'"))
    expect(claim?.sql).toContain('timeout_at=DATE_ADD(NOW(), INTERVAL 300 SECOND)')
    expect(claim?.sql).toContain('timeout_at IS NULL AND started_at <')
    expect(claim?.params).toEqual(['msg-1', 300])
  })
})
