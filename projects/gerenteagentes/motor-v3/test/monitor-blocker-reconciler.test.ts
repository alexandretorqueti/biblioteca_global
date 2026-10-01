import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MonitorBlockerReconciler } from '../src/monitor/index.js'

const BLOCKER = {
  block_id: 45,
  tarefa_id: 886,
  task_id: 'task-p1-886',
  block_reason: 'deploy_failed',
  block_command: 'motor-v3:deploy:batch-1',
  block_excerpt: 'falha no deploy',
  subtarefa_id: null,
}

function fakePool(active: boolean | string = true, blockers: unknown[] = []) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      if (String(sql).includes("chave = 'motor.monitor.active'")) return [[{ valor: active }], []]
      return [blockers, []]
    }),
  } as unknown as Pool
  return { pool, queries }
}

describe('MonitorBlockerReconciler', () => {
  it('não consulta nem reemite bloqueios quando o Monitor está pausado', async () => {
    const env = fakePool(false, [BLOCKER])
    const enqueue = vi.fn()
    const reconciler = new MonitorBlockerReconciler(env.pool, { enqueue })

    expect(await reconciler.reconcile()).toBe(0)
    expect(enqueue).not.toHaveBeenCalled()
    expect(env.queries).toHaveLength(1)
  })

  it('reemite cada bloqueio ativo sem TASK_BLOCKED pendente', async () => {
    const env = fakePool(true, [BLOCKER])
    const enqueue = vi.fn(async () => {})
    const reconciler = new MonitorBlockerReconciler(env.pool, { enqueue })

    expect(await reconciler.reconcile()).toBe(1)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      type: 'TASK_BLOCKED',
      taskId: 'task-p1-886',
      payload: { blockId: 45, databaseTaskId: 886, resumeReason: 'monitor_reactivation_reconciliation' },
    })
  })

  it('é idempotente por bloqueio: a consulta exclui mensagem pendente do outbox', async () => {
    const env = fakePool(true, [])
    const enqueue = vi.fn()
    const reconciler = new MonitorBlockerReconciler(env.pool, {
      enqueue,
      destinationQueue: 'motor.monitor.custom',
    })

    await reconciler.reconcile()
    expect(enqueue).not.toHaveBeenCalled()
    expect(env.queries[1]?.params).toEqual(['motor.monitor.custom'])
    expect(env.queries[1]?.sql).toContain("o.status = 'pending'")
    expect(env.queries[1]?.sql).toContain("JSON_EXTRACT(o.payload_json, '$.blockId')")
  })

  it('inicia e para a passagem periódica sem criar timers duplicados', () => {
    vi.useFakeTimers()
    try {
      const env = fakePool(true, [])
      const reconciler = new MonitorBlockerReconciler(env.pool, { enqueue: vi.fn(), intervalMs: 1_000 })
      reconciler.start()
      reconciler.start()
      reconciler.stop()
      reconciler.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
