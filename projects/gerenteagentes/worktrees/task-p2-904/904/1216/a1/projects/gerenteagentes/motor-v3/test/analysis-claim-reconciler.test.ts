import { describe, expect, it, vi } from 'vitest'
import { AnalysisClaimReconciler } from '../src/coordinator/index.js'
import type { Pool } from 'mysql2/promise'

function fakePool(selectRows: Record<string, unknown>[]) {
  const queries: { sql: string; params: unknown[] }[] = []
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params ?? [] })
      if (/^\s*SELECT/i.test(String(sql).trim())) return [selectRows]
      return [{ affectedRows: selectRows.length }]
    }),
  } as unknown as Pool
  return { pool, queries }
}

describe('AnalysisClaimReconciler (incidente 862)', () => {
  it('libera claims de análise órfãos no boot e retorna a trilha', async () => {
    const startedAt = new Date('2026-09-22T13:08:10.000Z')
    const { pool, queries } = fakePool([
      {
        tarefa_id: 862,
        external_id: 'task-p6-862',
        analysis_execution_id: 'exec-analyze-task-p6-862-msg-1-attempt-1',
        analysis_started_at: startedAt,
      },
      {
        tarefa_id: 900,
        external_id: null,
        analysis_execution_id: null,
        analysis_started_at: '2026-09-22 10:00:00',
      },
    ])

    const orphans = await new AnalysisClaimReconciler(pool).reconcile()

    expect(orphans).toHaveLength(2)
    expect(orphans[0]).toEqual({
      tarefaId: 862,
      taskExternalId: 'task-p6-862',
      analysisExecutionId: 'exec-analyze-task-p6-862-msg-1-attempt-1',
      analysisStartedAt: startedAt.toISOString(),
    })
    expect(orphans[1].tarefaId).toBe(900)
    expect(orphans[1].taskExternalId).toBeNull()

    // Um UPDATE por claim, sempre condicionado a analysis_started_at IS NOT NULL
    const updates = queries.filter(q => q.sql.startsWith('UPDATE'))
    expect(updates).toHaveLength(2)
    expect(updates[0].params).toEqual([862])
    expect(updates[1].params).toEqual([900])
    expect(updates[0].sql).toContain('analysis_started_at IS NOT NULL')
    expect(updates[0].sql).toContain('analysis_execution_id = NULL')
  })

  it('não faz nada quando não há claims pendentes', async () => {
    const { pool, queries } = fakePool([])

    const orphans = await new AnalysisClaimReconciler(pool).reconcile()

    expect(orphans).toEqual([])
    expect(queries.filter(q => q.sql.startsWith('UPDATE'))).toHaveLength(0)
  })
})
// @vitest-environment node
