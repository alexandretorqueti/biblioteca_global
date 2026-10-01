import { describe, expect, it, vi } from 'vitest'
import { DerivedTaskStatusResolver } from '../src/status/DerivedTaskStatus.js'

describe('DerivedTaskStatusResolver', () => {
  it('deriva failed quando qualquer subtarefa falhou definitivamente', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 855, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, terminal_status: null,
        awaiting_interaction: 0,
        has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'failed' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)
    await expect(resolver.resolve('task-p6-855')).resolves.toBe('failed')
  })

  it('prioriza bloqueio de deploy sobre integração concluída', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 857, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, terminal_status: 'completed',
        awaiting_interaction: 0,
        has_active_blocker: 1, deploy_succeeded: 0, deploy_failed: 1,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)
    await expect(resolver.resolve('task-p6-857')).resolves.toBe('blocked')
  })

  it('retorna awaiting_clarification somente quando clarification_pending_at está preenchido', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 860, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: new Date(), terminal_status: null,
        awaiting_interaction: 0,
        has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0,
      }]])
      .mockResolvedValueOnce([[]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)
    await expect(resolver.resolve('task-p6-860')).resolves.toBe('awaiting_clarification')
  })

  it('não retorna awaiting_clarification quando clarification_pending_at é nulo', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 861, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, terminal_status: null,
        awaiting_interaction: 0,
        has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified' }]])
      .mockResolvedValueOnce([[{ integration_confirmed_at: new Date() }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)
    // Sem clarification_pending_at, não deve retornar awaiting_clarification
    await expect(resolver.resolve('task-p6-861')).resolves.toBe('completed')
  })
})
// @vitest-environment node
