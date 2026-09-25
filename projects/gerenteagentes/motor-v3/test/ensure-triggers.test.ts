import { describe, expect, it, vi } from 'vitest'
import { ensureCompletionTrigger, SUBTASK_COMPLETION_TRIGGER } from '../src/db/ensureTriggers.js'

function fakePool(acquired: number) {
  const calls: string[] = []
  const connection = {
    query: vi.fn(async (sql: string) => {
      calls.push(String(sql))
      if (/GET_LOCK/.test(String(sql))) return [[{ acquired }]]
      if (/RELEASE_LOCK/.test(String(sql))) return [[{ 'RELEASE_LOCK(?, 30)': 1 }]]
      return [{ affectedRows: 0 }]
    }),
    release: vi.fn(),
  }
  return { pool: { getConnection: vi.fn(async () => connection) }, calls, connection }
}

describe('ensureCompletionTrigger (camada A)', () => {
  it('instala o trigger com lock e o libera ao final', async () => {
    const fake = fakePool(1)
    const installed = await ensureCompletionTrigger(fake.pool as never)

    expect(installed).toBe(true)
    expect(fake.calls.some(sql => /GET_LOCK/.test(sql))).toBe(true)
    expect(fake.calls.some(sql => sql.includes('DROP TRIGGER IF EXISTS') && sql.includes(SUBTASK_COMPLETION_TRIGGER))).toBe(true)
    const create = fake.calls.find(sql => sql.includes('CREATE TRIGGER'))
    expect(create).toBeDefined()
    expect(create).toContain('@motor_completing IS NULL')
    expect(create).toContain("NEW.status IN ('verified', 'superseded')")
    expect(create).toContain('task_runtime_facts')
    expect(create).toContain('deploy-completed-trigger-')
    expect(create).toContain("t.tipo = 'desenvolvimento'")
    expect(create).toContain('t.paused_at IS NULL')
    expect(fake.calls.some(sql => /RELEASE_LOCK/.test(sql))).toBe(true)
    expect(fake.connection.release).toHaveBeenCalled()
  })

  it('não cria nada quando o lock está ocupado (blue/green simultâneo)', async () => {
    const fake = fakePool(0)
    const installed = await ensureCompletionTrigger(fake.pool as never)

    expect(installed).toBe(false)
    expect(fake.calls.some(sql => sql.includes('CREATE TRIGGER'))).toBe(false)
    expect(fake.calls.some(sql => /RELEASE_LOCK/.test(sql))).toBe(false)
    expect(fake.connection.release).toHaveBeenCalled()
  })

  it('libera lock e conexão mesmo quando o CREATE falha', async () => {
    const fake = fakePool(1)
    fake.connection.query = vi.fn(async (sql: string) => {
      fake.calls.push(String(sql))
      if (/GET_LOCK/.test(String(sql))) return [[{ acquired: 1 }]]
      if (/RELEASE_LOCK/.test(String(sql))) return [[{}]]
      if (String(sql).includes('CREATE TRIGGER')) throw new Error('boom')
      return [{ affectedRows: 0 }]
    }) as never

    await expect(ensureCompletionTrigger(fake.pool as never)).rejects.toThrow('boom')
    expect(fake.calls.some(sql => /RELEASE_LOCK/.test(sql))).toBe(true)
    expect(fake.connection.release).toHaveBeenCalled()
  })
})
