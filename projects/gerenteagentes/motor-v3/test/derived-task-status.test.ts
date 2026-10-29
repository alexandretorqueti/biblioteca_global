import { describe, expect, it, vi } from 'vitest'
import { DerivedTaskStatusResolver } from '../src/status/DerivedTaskStatus.js'

describe('DerivedTaskStatusResolver', () => {
  it('deriva closed para verificacao direta sem subtarefas', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 970, task_type: 'verificacao', paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: new Date(), terminal_status: 'completed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
      }]])
      .mockResolvedValueOnce([[]])
    await expect(new DerivedTaskStatusResolver({ query } as never).resolve('task-p1-970')).resolves.toBe('closed')
  })

  it('deriva closed para a combinação factual da tarefa 1029 (desenvolvimento, completed, sem subtarefas)', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 1029, task_type: 'desenvolvimento', paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null, terminal_status: 'completed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
        active_monitor_fix: 0,
      }]])
      .mockResolvedValueOnce([[]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    // Nunca `planned`: terminal_status='completed' sem subtarefas é fato
    // terminal independentemente do tipo da tarefa.
    await expect(resolver.resolve('task-p2-1029')).resolves.toBe('closed')
  })

  it('deriva closed para completed sem subtarefas mesmo com análise iniciada', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 1030, task_type: 'desenvolvimento', paused_at: null, resource_wait_key: null,
        analysis_started_at: new Date(), clarification_pending_at: null, integration_confirmed_at: null, terminal_status: 'completed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
        active_monitor_fix: 0,
      }]])
      .mockResolvedValueOnce([[]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    // O fato terminal precede `analyzing`: encerramento transacional vence.
    await expect(resolver.resolve('task-p2-1030')).resolves.toBe('closed')
  })

  it('deriva cancelled para terminal_status=cancelled sem subtarefas', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 1031, task_type: 'desenvolvimento', paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null, terminal_status: 'cancelled',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
        active_monitor_fix: 0,
      }]])
      .mockResolvedValueOnce([[]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p2-1031')).resolves.toBe('cancelled')
  })

  it('deriva failed para terminal_status=failed sem subtarefas', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 1032, task_type: 'verificacao', paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null, terminal_status: 'failed',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0, administrative_deploy_cancelled: 0,
        active_monitor_fix: 0,
      }]])
      .mockResolvedValueOnce([[]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p2-1032')).resolves.toBe('failed')
  })

  it('expõe motor_fix somente enquanto há execução ativa de correção do Monitor', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 854, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null, terminal_status: null,
        awaiting_interaction: 0, has_active_blocker: 1, deploy_succeeded: 0, deploy_failed: 0,
        administrative_deploy_cancelled: 0, active_monitor_fix: 1,
      }]])
      .mockResolvedValueOnce([[{ status: 'blocked' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p6-854')).resolves.toBe('motor_fix')
    expect(query.mock.calls[0]?.[0]).toContain("mae.phase = 'monitor'")
  })

  it('não persiste motor_fix como estado terminal após a limpeza da execução', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 856, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null, terminal_status: 'motor_fix',
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0,
        administrative_deploy_cancelled: 0, active_monitor_fix: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'verified' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)

    await expect(resolver.resolve('task-p6-856')).resolves.toBe('ready')
  })

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
