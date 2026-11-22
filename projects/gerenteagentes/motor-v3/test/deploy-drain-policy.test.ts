// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { evaluateDeployDrain } from '../src/deploy/DeployDrainPolicy.js'

function connection(config: number, pending: Array<Record<string, unknown>>) {
  const query = vi.fn()
      .mockResolvedValueOnce([[{ valor: config }], []])
      .mockResolvedValueOnce([pending, []])
  return { database: { query } as unknown as Pool, query }
}

describe('DeployDrainPolicy', () => {
  it('ativa para pedido pendente elegível envelhecido', async () => {
    const result = await evaluateDeployDrain(connection(1, [{ id: 1087, age_minutes: 2 }]).database)
    expect(result).toEqual({ active: true, thresholdMinutes: 1, oldestPendingAgeMinutes: 2, oldestRequestId: 1087 })
  })

  it('mantém paridade quando threshold é zero', async () => {
    const result = await evaluateDeployDrain(connection(0, [{ id: 1087, age_minutes: 999 }]).database)
    expect(result.active).toBe(false)
    expect(result.thresholdMinutes).toBe(0)
  })

  it('não ativa sem pedido elegível — bloqueio ativo é excluído pelo SQL', async () => {
    const mock = connection(1, [])
    const result = await evaluateDeployDrain(mock.database)
    expect(result.active).toBe(false)
    expect(String(mock.query.mock.calls[1]?.[0])).toContain('NOT EXISTS')
    expect(String(mock.query.mock.calls[1]?.[0])).toContain('b.resolved_at IS NULL')
  })
})
