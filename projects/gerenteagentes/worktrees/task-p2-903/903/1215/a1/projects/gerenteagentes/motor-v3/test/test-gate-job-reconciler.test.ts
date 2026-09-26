import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { TestGateJobReconciler } from '../src/testing/TestGateJobReconciler.js'
import type { QueueMessage } from '../src/queue/index.js'

/**
 * Incidente de 2026-09-25: job 64 (pre_deploy, tarefa 886) ficou órfão em
 * `processing` após a troca blue-green; a mensagem TEST_RUN_REQUESTED esgotou
 * os retries dentro da janela de re-claim (20 min) e foi para a DLQ. Sem
 * recuperação, isMotorIdle() fica false para sempre e o pipeline de deploy
 * trava (dispatches de 835/836/887 mortos na DLQ).
 */

function fakePool(rows: unknown[] | Error): { pool: Pool; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql: String(sql), params: params ?? [] })
      if (rows instanceof Error) throw rows
      return [rows, []]
    }),
  } as unknown as Pool
  return { pool, queries }
}

const staleJob = {
  id: 64,
  request_message_id: '78fdfbb9-8bc1-45fd-b0c8-930a84dd9ce4',
  task_external_id: 'task-p1-886',
  status: 'processing',
  updated_at: new Date('2026-09-25T12:49:59Z'),
}

describe('TestGateJobReconciler', () => {
  it('reenfileira TEST_RUN_REQUESTED para job órfão com payload compatível com o consumer', async () => {
    const { pool, queries } = fakePool([staleJob])
    const enqueued: QueueMessage[] = []
    const reconciler = new TestGateJobReconciler(pool, { enqueue: async message => { enqueued.push(message) } })

    const recovered = await reconciler.reconcile()

    expect(recovered).toEqual([64])
    expect(enqueued).toHaveLength(1)
    const message = enqueued[0]!
    expect(message.type).toBe('TEST_RUN_REQUESTED')
    expect(message.taskId).toBe('task-p1-886')
    expect(message.payload).toMatchObject({ jobId: 64, recovered: true })
    expect(message.correlationId).toBe(staleJob.request_message_id)
    expect(message.executionId).toMatch(/^gate-recovery-64-/)
    // Janela de obsolescência deve casar com o re-claim do TestGateConsumer (20 min)
    expect(queries[0]!.sql).toContain("status = 'processing'")
    expect(queries[0]!.sql).toContain("status = 'pending'")
    expect(queries[0]!.params).toEqual([20, 20])
  })

  it('janela e intervalo configuráveis', async () => {
    const { pool, queries } = fakePool([])
    const reconciler = new TestGateJobReconciler(pool, { enqueue: async () => {}, staleMinutes: 35, intervalMs: 60_000 })

    await reconciler.reconcile()

    expect(queries[0]!.params).toEqual([35, 35])
  })

  it('sem jobs órfãos não enfileira nada', async () => {
    const { pool } = fakePool([])
    const enqueue = vi.fn(async () => {})
    const reconciler = new TestGateJobReconciler(pool, { enqueue })

    await expect(reconciler.reconcile()).resolves.toEqual([])
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('falha de banco não propaga (barreira de erro, como nos demais reconciliadores)', async () => {
    const { pool } = fakePool(new Error('conexão recusada'))
    const reconciler = new TestGateJobReconciler(pool, { enqueue: async () => {} })

    await expect(reconciler.reconcile()).resolves.toEqual([])
  })

  it('falha de enqueue interrompe a passagem sem propagar', async () => {
    const { pool } = fakePool([staleJob])
    const reconciler = new TestGateJobReconciler(pool, {
      enqueue: async () => { throw new Error('Outbox de gates indisponível para recuperação') },
    })

    await expect(reconciler.reconcile()).resolves.toEqual([])
  })
})
