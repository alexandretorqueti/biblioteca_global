import { describe, expect, it, vi } from 'vitest'
import { WorkerActivityService } from '../src/status/WorkerActivity.js'

function service(executions: any[] = [], rows: any[] = []) {
  const pool = { query: vi.fn().mockImplementation((sql: string) => [
    sql.includes('deploy_batches')
      ? rows.filter(row => row.task_id != null && row.execution_id == null)
      : sql.includes('motor_active_executions')
        ? rows.filter(row => row.execution_id != null)
        : [],
  ]) }
  const gate = { isActive: vi.fn().mockResolvedValue(true) }
  return { activity: new WorkerActivityService(pool as any, () => executions, gate), pool, gate }
}

describe('WorkerActivityService', () => {
  it('diferencia analista, desenvolvedor e gerente/monitor e informa o modelo atual', async () => {
    const { activity } = service([
      { executionId: 'analysis-1', taskId: 't-1', startedAt: 10, lastHeartbeat: 20, context: { agentId: 'analyst', model: 'modelo-analista', phase: 'analysis' } },
      { executionId: 'dev-1', taskId: 't-2', subtaskId: 2, startedAt: 11, lastHeartbeat: 21, context: { agentId: 'project-agent', model: 'modelo-dev', phase: 'development' } },
      { executionId: 'analysis-monitor-1', taskId: 't-3', startedAt: 12, lastHeartbeat: 22, context: { agentId: 'motor-monitor', model: 'modelo-monitor', phase: 'testing' } },
    ])

    const result = await activity.getActivity()

    expect(result.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'analyst', active: true, model: 'modelo-analista', taskId: 't-1' }),
      expect.objectContaining({ role: 'developer', active: true, model: 'modelo-dev', taskId: 't-2' }),
      expect.objectContaining({ role: 'manager', active: true, model: 'modelo-monitor', taskId: 't-3' }),
    ]))
    expect(result.motor.isRunning).toBe(true)
    expect(result.motor.activity).toEqual(expect.objectContaining({ kind: 'testing', message: 'testando tarefa t-3' }))
  })

  it('retorna os três papéis inativos quando não há execução vigente', async () => {
    const { activity } = service()
    const result = await activity.getActivity()

    expect(result.motor).toMatchObject({ isActive: true, isRunning: false, activeExecutionsCount: 0, activity: null })
    expect(result.workers).toHaveLength(3)
    expect(result.workers.every(worker => worker.active === false && worker.model === null)).toBe(true)
  })

  it('ignora lease expirado e não inventa modelo indisponível', async () => {
    // A consulta do serviço contém `expires_at > NOW()`; portanto um lease
    // expirado não chega à camada de contrato.
    const { activity } = service([], [])
    const result = await activity.getActivity()

    expect(result.workers.find(worker => worker.role === 'developer')?.model).toBeNull()
    expect(result.motor.isRunning).toBe(false)
  })

  it('ativa o desenvolvedor a partir do lease persistido e o desativa quando o lease some', async () => {
    const persisted = [{
      execution_id: 'dev-persisted', task_id: 'task-dev', subtask_id: 7, phase: 'development',
      model: 'modelo-dev', agent_id: 'project-agent', started_at: new Date(1000), heartbeat_at: new Date(2000),
    }]
    const active = service([], persisted)
    await expect(active.activity.getActivity()).resolves.toEqual(expect.objectContaining({
      motor: expect.objectContaining({ isRunning: true }),
      workers: expect.arrayContaining([expect.objectContaining({
        role: 'developer', active: true, taskId: 'task-dev', subtaskId: 7, model: 'modelo-dev',
      })]),
    }))

    const inactive = service([], [])
    await expect(inactive.activity.getActivity()).resolves.toEqual(expect.objectContaining({
      motor: expect.objectContaining({ isRunning: false }),
      workers: expect.arrayContaining([expect.objectContaining({ role: 'developer', active: false })]),
    }))
  })

  it('mantém o Monitor ativo durante a verificação pós-deploy e limpa o snapshot ao finalizar', async () => {
    const postDeploy = service([], [{
      execution_id: 'postdeploy-batch-1', task_id: 'task-deployed', subtask_id: null,
      phase: 'postdeploy_monitor', model: 'modelo-monitor', agent_id: 'monitor-pos-deploy',
      started_at: new Date(1000), heartbeat_at: new Date(2000),
    }])
    await expect(postDeploy.activity.getActivity()).resolves.toEqual(expect.objectContaining({
      motor: expect.objectContaining({ isRunning: true, activeExecutionsCount: 1 }),
      workers: expect.arrayContaining([expect.objectContaining({
        role: 'manager', active: true, phase: 'postdeploy_monitor', taskId: 'task-deployed',
      })]),
    }))

    const finished = service([], [])
    await expect(finished.activity.getActivity()).resolves.toEqual(expect.objectContaining({
      motor: expect.objectContaining({ isRunning: false, activeExecutionsCount: 0, activity: null }),
      workers: expect.arrayContaining([expect.objectContaining({ role: 'manager', active: false })]),
    }))
  })

  it('exibe o modelo do Monitor em missão ativa lido da própria execução (e.model, sem sessão de subtarefa)', async () => {
    // Missão do Monitor sem subtarefa: analyst_task_sessions/motor_agent_sessions
    // não cobrem a linha; a fonte do modelo é motor_active_executions.model
    // (COALESCE(ats.model, mas.model, e.model) da query de leitura).
    const { activity, pool } = service([], [{
      execution_id: 'monitor-77-1', task_id: 'task-blocked', subtask_id: null,
      phase: 'monitor', model: 'ollama/qwen3:8b', agent_id: null,
      started_at: new Date(1000), heartbeat_at: new Date(2000),
    }])

    const result = await activity.getActivity()

    // A query precisa selecionar e.model no COALESCE (migration 0109).
    const executionsSql = String(pool.query.mock.calls
      .find(([sql]: [string]) => sql.includes('motor_active_executions'))?.[0] ?? '')
    expect(executionsSql).toContain('COALESCE(ats.model, mas.model, e.model)')

    expect(result.workers).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'manager', active: true, model: 'ollama/qwen3:8b', taskId: 'task-blocked', phase: 'monitor',
    })]))
  })

  it('retorna model null para execução vigente sem modelo conhecido em nenhuma fonte', async () => {
    // Nunca inventar fallback: e.model NULL sem sessão ativa → model null.
    const { activity } = service([], [{
      execution_id: 'monitor-88-1', task_id: 'task-blocked', subtask_id: null,
      phase: 'monitor', model: null, agent_id: null,
      started_at: new Date(1000), heartbeat_at: new Date(2000),
    }])

    const result = await activity.getActivity()

    expect(result.motor.isRunning).toBe(true)
    const manager = result.workers.find(worker => worker.role === 'manager')
    expect(manager).toMatchObject({ active: true, model: null })
  })

  it('mantém o motor ativo e exibe deploy enquanto há lote de deploy running', async () => {
    const { activity } = service([], [{ task_id: 'task-p12-909' }])

    const result = await activity.getActivity()

    expect(result.motor).toMatchObject({ isRunning: true, activeExecutionsCount: 1 })
    expect(result.motor.activity).toEqual({
      kind: 'deploying',
      message: 'fazendo deploy das tarefas task-p12-909',
      taskIds: ['task-p12-909'],
    })
    expect(result.workers.find(worker => worker.role === 'manager')).toMatchObject({
      active: true,
      phase: 'deploying',
      taskId: 'task-p12-909',
    })
  })

  it.each(['git_merge', 'integration_promotion', 'baseline_fix'])('classifica a fase %s como git e preserva taskIds', async phase => {
    const { activity } = service([
      { executionId: 'git-1', taskId: 'task-p12-909', startedAt: 10, lastHeartbeat: 20,
        context: { agentId: 'project-agent', phase } },
    ])

    const result = await activity.getActivity()

    expect(result.motor.activity).toEqual(expect.objectContaining({ kind: 'git', taskIds: ['task-p12-909'] }))
  })
})
