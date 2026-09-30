import { describe, expect, it, vi } from 'vitest'
import { createGovernanceFlagResolver, governanceFlagKey } from '../src/governance/RolloutPolicy.js'

describe('GovernanceRollout', () => {
  it('lê a flag persistida e gera a chave canônica', async () => {
    const query = vi.fn(async () => [[{ valor: 'true' }], []])
    const resolver = createGovernanceFlagResolver({ query } as any)

    await expect(resolver(governanceFlagKey('analysis_terminal'))).resolves.toBe(true)
    expect(query).toHaveBeenCalledWith(
      'SELECT valor FROM motor_configuracoes WHERE chave = ? LIMIT 1',
      ['governed_failure_analysis_terminal'],
    )
  })

  it('mantém o fallback quando a flag está ausente, inválida ou o banco falha', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ valor: 'valor-invalido' }], []])
      .mockRejectedValueOnce(new Error('db indisponível'))
    const resolver = createGovernanceFlagResolver({ query } as any)

    await expect(resolver('governed_failure_missing')).resolves.toBe(false)
    await expect(resolver('governed_failure_invalid')).resolves.toBe(false)
    await expect(resolver('governed_failure_db_error')).resolves.toBe(false)
  })
})
