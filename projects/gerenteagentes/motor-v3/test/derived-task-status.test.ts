import { describe, expect, it, vi } from 'vitest'
import { DerivedTaskStatusResolver } from '../src/status/DerivedTaskStatus.js'

describe('DerivedTaskStatusResolver', () => {
  it('deriva failed quando qualquer subtarefa falhou definitivamente', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 855, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null, terminal_status: null,
        awaiting_interaction: 0,
        has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'failed' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)
    await expect(resolver.resolve('task-p6-855')).resolves.toBe('failed')
  })

  it('prioriza bloqueio de deploy sobre integração concluída', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 857, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: new Date(), terminal_status: 'completed',
        awaiting_interaction: 0,
        has_active_blocker: 1, deploy_succeeded: 0, deploy_failed: 1, administrative_deploy_cancelled: 0,
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
        integration_confirmed_at: null, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
      }]])
      .mockResolvedValueOnce([[]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)
    await expect(resolver.resolve('task-p6-860')).resolves.toBe('awaiting_clarification')
  })

  it('não retorna awaiting_clarification quando clarification_pending_at é nulo', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 861, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: new Date(), terminal_status: null,
        awaiting_interaction: 0,
        has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified', completion_kind: 'code_change', workspace_status: 'integrated' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)
    // Sem clarification_pending_at, não deve retornar awaiting_clarification
    await expect(resolver.resolve('task-p6-861')).resolves.toBe('completed')
  })

  it('deriva closed para tarefa integralmente analítica com integração confirmada', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 953, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: new Date(), terminal_status: 'completed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified', completion_kind: 'analysis', workspace_status: 'approved' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p1-953')).resolves.toBe('closed')
    expect(query.mock.calls[1]?.[0]).toContain('status, completion_kind, workspace_status')
  })

  it('mantém completed quando há código integrado', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 954, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: new Date(), terminal_status: 'completed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified', completion_kind: 'code_change', workspace_status: 'integrated' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p1-954')).resolves.toBe('completed')
  })

  it('deriva closed para tombstone de adjudicação administrativa sem deploy', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 958, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: new Date(), terminal_status: 'completed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 1,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified', completion_kind: 'code_change', workspace_status: 'integrated' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p1-958')).resolves.toBe('closed')
    expect(query.mock.calls[0]?.[0]).toContain("last_error LIKE 'Adjudicação administrativa sem deploy%'")
  })

  it('mantém deployed como precedência sobre tombstone de adjudicação', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 962, paused_at: new Date(), resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: new Date(), terminal_status: 'completed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 1, deploy_failed: 0, administrative_deploy_cancelled: 1,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified', completion_kind: 'code_change', workspace_status: 'integrated' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p1-962')).resolves.toBe('deployed')
  })

  it('aplica closed também quando a tarefa analítica está pausada', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 963, paused_at: new Date(), resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: new Date(), terminal_status: 'completed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified', completion_kind: 'analysis', workspace_status: 'approved' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p1-963')).resolves.toBe('closed')
  })
})
// @vitest-environment node
