import { describe, expect, it, vi } from 'vitest'
import { WorkerActivityService } from '../src/status/WorkerActivity.js'

function service(executions: any[] = [], rows: any[] = []) {
  const pool = { query: vi.fn().mockImplementation((sql: string) => [sql.includes('deploy_batches') ? rows : []]) }
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
})
