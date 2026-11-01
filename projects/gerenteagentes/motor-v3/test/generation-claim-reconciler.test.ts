// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { GenerationClaimReconciler } from '../src/generation/index.js'
import type { Pool } from 'mysql2/promise'

function fakePool(selectRows: Record<string, unknown>[], options: { failSelect?: boolean } = {}) {
  const queries: { sql: string; params: unknown[] }[] = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      queries.push({ sql: normalized, params: params ?? [] })
      if (/^\s*SELECT/i.test(normalized)) {
        if (options.failSelect) throw new Error('MySQL server has gone away')
        return [selectRows]
      }
      return [{ affectedRows: selectRows.length }]
    }),
  } as unknown as Pool
  return { pool, queries }
}

const RUNNING_ROW = {
  id: 41,
  status: 'running',
  worker_id: 'host-generation-99',
  claimed_at: '2026-11-01 10:00:00',
  lease_expires_at: '2026-11-01 10:05:00',
}

describe('GenerationClaimReconciler (Geração Macro F1 — task-p2-1056)', () => {
  it('boot (instância única): devolve TODA geracao running para pending, sem esperar lease vencer', async () => {
    const { pool, queries } = fakePool([RUNNING_ROW, { ...RUNNING_ROW, id: 42 }])

    const recovered = await new GenerationClaimReconciler(pool).reconcile({ treatAllRunningAsOrphans: true })

    expect(recovered).toEqual([41, 42])
    const select = queries.find(q => q.sql.startsWith('SELECT'))!
    expect(select.sql).toContain("WHERE status = 'running'")
    // No boot não filtra lease: qualquer running remanescente é órfão.
    expect(select.sql).not.toContain('lease_expires_at <')
    const updates = queries.filter(q => q.sql.startsWith('UPDATE'))
    expect(updates).toHaveLength(2)
    expect(updates[0].params).toEqual([41])
    expect(updates[0].sql).toContain("SET status = 'pending'")
    expect(updates[0].sql).toContain('worker_id = NULL')
    expect(updates[0].sql).toContain('claimed_at = NULL')
    expect(updates[0].sql).toContain('lease_expires_at = NULL')
    // Idempotência: UPDATE sempre condicionado a status='running'.
    expect(updates[0].sql).toContain("WHERE id = ? AND status = 'running'")
  })

  it('ciclo periódico: somente lease vencido (ou running sem claim) entra no escopo', async () => {
    const { pool, queries } = fakePool([RUNNING_ROW])

    const recovered = await new GenerationClaimReconciler(pool, { staleMinutes: 15 }).reconcile()

    expect(recovered).toEqual([41])
    const select = queries.find(q => q.sql.startsWith('SELECT'))!
    expect(select.sql).toContain('lease_expires_at IS NOT NULL AND lease_expires_at < NOW(3)')
    expect(select.sql).toContain('claimed_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE)')
    // revise sem claim (lease NULL, claimed_at NULL) também é normalizado.
    expect(select.sql).toContain('lease_expires_at IS NULL AND claimed_at IS NULL')
    expect(select.params).toEqual([15])
  })

  it('não faz nada quando não há gerações órfãs', async () => {
    const { pool, queries } = fakePool([])

    const recovered = await new GenerationClaimReconciler(pool).reconcile()

    expect(recovered).toEqual([])
    expect(queries.filter(q => q.sql.startsWith('UPDATE'))).toHaveLength(0)
  })

  it('erro de banco não propaga (barreira, como nos demais reconciliadores)', async () => {
    const { pool } = fakePool([], { failSelect: true })

    await expect(new GenerationClaimReconciler(pool).reconcile()).resolves.toEqual([])
  })

  it('start/stop controlam o ciclo de 5 min (padrão TestGateJobReconciler)', async () => {
    vi.useFakeTimers()
    try {
      const { pool } = fakePool([])
      const reconciler = new GenerationClaimReconciler(pool, { intervalMs: 300_000 })
      reconciler.start()
      await vi.advanceTimersByTimeAsync(300_000)
      expect(pool.query).toHaveBeenCalled()
      reconciler.stop()
      const callsAfterStop = vi.mocked(pool.query).mock.calls.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(vi.mocked(pool.query).mock.calls.length).toBe(callsAfterStop)
    } finally {
      vi.useRealTimers()
    }
  })
})
