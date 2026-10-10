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

  it('reenfileira bloqueio com block_reason baseline_preflight_failed (incidente 939/1273)', async () => {
    const baselineBlocker = {
      block_id: 88,
      tarefa_id: 939,
      task_id: 'task-p2-939',
      block_reason: 'baseline_preflight_failed',
      block_command: 'SUBTASK_EXECUTION_BLOCKED',
      block_excerpt: '{"phase":"baseline_preflight","executionId":"exec-1273","subtaskId":1273,"error":"lint errors"}',
      subtarefa_id: 1273,
    }
    const env = fakePool(true, [baselineBlocker])
    const enqueue = vi.fn(async () => {})
    const reconciler = new MonitorBlockerReconciler(env.pool, { enqueue })

    expect(await reconciler.reconcile()).toBe(1)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      type: 'TASK_BLOCKED',
      taskId: 'task-p2-939',
      payload: {
        blockId: 88,
        databaseTaskId: 939,
        blockReason: 'baseline_preflight_failed',
        blockCommand: 'SUBTASK_EXECUTION_BLOCKED',
        subtaskId: 1273,
        resumeReason: 'monitor_reactivation_reconciliation',
      },
    })
  })

  it('reenfileira bloqueio com block_reason development_completion_protocol_exhausted (incidente 939/1273)', async () => {
    const completionBlocker = {
      block_id: 99,
      tarefa_id: 939,
      task_id: 'task-p2-939',
      block_reason: 'development_completion_protocol_exhausted',
      block_command: 'SUBTASK_EXECUTION_BLOCKED',
      block_excerpt: '{"phase":"development_completion_protocol","executionId":"exec-1273","subtaskId":1273}',
      subtarefa_id: 1273,
    }
    const env = fakePool(true, [completionBlocker])
    const enqueue = vi.fn(async () => {})
    const reconciler = new MonitorBlockerReconciler(env.pool, { enqueue })

    expect(await reconciler.reconcile()).toBe(1)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      type: 'TASK_BLOCKED',
      taskId: 'task-p2-939',
      payload: {
        blockId: 99,
        databaseTaskId: 939,
        blockReason: 'development_completion_protocol_exhausted',
        blockCommand: 'SUBTASK_EXECUTION_BLOCKED',
        subtaskId: 1273,
        resumeReason: 'monitor_reactivation_reconciliation',
      },
    })
  })

  it('reenfileira múltiplos bloqueios incluindo os novos block_reasons em uma única passagem', async () => {
    const blockers = [
      BLOCKER,
      {
        block_id: 88,
        tarefa_id: 939,
        task_id: 'task-p2-939',
        block_reason: 'baseline_preflight_failed',
        block_command: 'SUBTASK_EXECUTION_BLOCKED',
        block_excerpt: 'baseline',
        subtarefa_id: 1273,
      },
      {
        block_id: 99,
        tarefa_id: 940,
        task_id: 'task-p2-940',
        block_reason: 'development_completion_protocol_exhausted',
        block_command: 'SUBTASK_EXECUTION_BLOCKED',
        block_excerpt: 'completion',
        subtarefa_id: 1300,
      },
    ]
    const env = fakePool(true, blockers)
    const enqueue = vi.fn(async () => {})
    const reconciler = new MonitorBlockerReconciler(env.pool, { enqueue })

    expect(await reconciler.reconcile()).toBe(3)
    expect(enqueue).toHaveBeenCalledTimes(3)
  })
})
