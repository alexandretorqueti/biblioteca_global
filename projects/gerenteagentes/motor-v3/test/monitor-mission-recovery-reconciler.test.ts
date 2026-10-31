import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MonitorMissionRecoveryReconciler } from '../src/monitor/index.js'
import type { TaskEventSink } from '../src/coordinator/TaskEventRecorder.js'
import type { MonitorHumanNotifier } from '../src/monitor/index.js'

const ORPHAN = {
  block_id: 3457,
  tarefa_id: 1048,
  task_id: 'task-p2-1048',
  block_reason: 'subtask_verification_failed',
  block_command: null,
  block_excerpt: 'Duplicate entry motor_outbox',
  subtarefa_id: 1447,
  last_evento: 'monitor_resolution_started',
  last_at: new Date(Date.now() - 45 * 60_000),
  started_count: 1,
}

function fakePool(active: boolean | string = true, orphans: unknown[] = []) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      if (String(sql).includes("chave = 'motor.monitor.active'")) return [[{ valor: active }], []]
      return [orphans, []]
    }),
  } as unknown as Pool
  return { pool, queries }
}

function fakeEvents() {
  const record = vi.fn(async () => {})
  return { record, sink: { record } as unknown as TaskEventSink }
}

function fakeNotifier() {
  const notify = vi.fn(async () => {})
  return { notify, notifier: { notify } as MonitorHumanNotifier }
}

describe('MonitorMissionRecoveryReconciler', () => {
  it('não consulta nem reemite quando o Monitor está pausado', async () => {
    const env = fakePool(false, [ORPHAN])
    const enqueue = vi.fn()
    const reconciler = new MonitorMissionRecoveryReconciler(env.pool, { enqueue })

    expect(await reconciler.reconcile()).toBe(0)
    expect(enqueue).not.toHaveBeenCalled()
    expect(env.queries).toHaveLength(1)
  })

  it('reemite TASK_BLOCKED de missão órfã e registra o evento requeued', async () => {
    const env = fakePool(true, [ORPHAN])
    const enqueue = vi.fn(async () => {})
    const { record, sink } = fakeEvents()
    const reconciler = new MonitorMissionRecoveryReconciler(env.pool, { enqueue, events: sink })

    expect(await reconciler.reconcile()).toBe(1)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      type: 'TASK_BLOCKED',
      taskId: 'task-p2-1048',
      payload: {
        blockId: 3457,
        databaseTaskId: 1048,
        subtaskId: 1447,
        resumeReason: 'monitor_mission_recovery',
      },
    })
    expect(record).toHaveBeenCalledWith(
      'task-p2-1048',
      'monitor_resolution_requeued',
      'motor',
      expect.objectContaining({ blockId: 3457, startedCount: 1 }),
    )
  })

  it('a consulta casa órfãos: último evento não-terminal antigo, sem execução monitor viva', async () => {
    const env = fakePool(true, [])
    const reconciler = new MonitorMissionRecoveryReconciler(env.pool, { enqueue: vi.fn() })

    await reconciler.reconcile()
    const sql = env.queries[1]?.sql ?? ''
    expect(sql).toContain("b.resolved_at IS NULL")
    expect(sql).toContain("agg.last_evento IN ('monitor_resolution_started', 'monitor_resolution_capacity_waiting')")
    expect(sql).toContain('NOW() - INTERVAL ? MINUTE')
    expect(sql).toContain("mae.phase = 'monitor'")
    expect(sql).toContain("mae.execution_id LIKE CONCAT('monitor-', b.id, '-%')")
    expect(sql).toContain('mae.expires_at > NOW()')
    expect(env.queries[1]?.params).toEqual([5])
  })

  it('após esgotar as missões, escala para o humano em vez de re-enfileirar', async () => {
    const exhausted = { ...ORPHAN, started_count: 3 }
    const env = fakePool(true, [exhausted])
    const enqueue = vi.fn()
    const { record, sink } = fakeEvents()
    const { notify, notifier } = fakeNotifier()
    const reconciler = new MonitorMissionRecoveryReconciler(env.pool, {
      enqueue, events: sink, notifier, maxMissionsPerBlock: 3,
    })

    expect(await reconciler.reconcile()).toBe(0)
    expect(enqueue).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith(
      'task-p2-1048',
      'monitor_resolution_orphan_exhausted',
      'motor',
      expect.objectContaining({ blockId: 3457, startedCount: 3 }),
    )
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-p2-1048',
      blockId: 3457,
      blockReason: 'subtask_verification_failed',
    }))
  })

  it('falha de banco não propaga: retorna 0 e mantém o ciclo vivo', async () => {
    const pool = {
      query: vi.fn(async () => { throw new Error('db fora do ar') }),
    } as unknown as Pool
    const enqueue = vi.fn()
    const reconciler = new MonitorMissionRecoveryReconciler(pool, { enqueue })

    expect(await reconciler.reconcile()).toBe(0)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('inicia e para o ciclo periódico sem timers duplicados', () => {
    vi.useFakeTimers()
    try {
      const env = fakePool(true, [])
      const reconciler = new MonitorMissionRecoveryReconciler(env.pool, { enqueue: vi.fn(), intervalMs: 1_000 })
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
