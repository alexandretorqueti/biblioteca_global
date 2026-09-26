import { describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../src/bus/MessageBus.js'
import { TaskCoordinator, type TaskCoordinatorConfig, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
import type { OperationLogEntry, OperationLogger } from '../src/commands/index.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1', title: 'Tarefa', description: 'Descrição', taskType: 'desenvolvimento', agentId: 'agent-1',
    projectSlug: 'projeto', repoPath: '/tmp/projeto', status: 'planned', paused: false,
    terminal: false, analysisStartedAt: null, subtaskCount: 0,
    dependsOnTaskId: null, dependencyTerminalStatus: null, dependencyDeployStatus: null, dependencyTaskType: null,
    ...overrides,
  }
}

function command(type = 'TASK_RESUME_REQUESTED'): QueueMessage {
  return createQueueMessage({ type, taskId: 'task-1', executionId: 'source-exec', payload: {} })
}

function setup(snapshot: TaskSnapshot | null = task(), config: TaskCoordinatorConfig = {}) {
  const bus = new MessageBus()
  const entries: OperationLogEntry[] = []
  const logger: OperationLogger = { append: vi.fn(async entry => { entries.push(entry) }) }
  const eventos: { taskId: string; evento: string; payload?: Record<string, unknown> | null }[] = []
  const taskEvents = { record: vi.fn(async (taskId: string, evento: string, _ator?: string, payload?: Record<string, unknown> | null) => { eventos.push({ taskId, evento, payload }) }) }
  const repository: TaskCoordinatorRepository = {
    getTask: vi.fn(async () => snapshot),
    claimAnalysis: vi.fn(async () => true),
    releaseAnalysisClaim: vi.fn(async () => {}),
    persistAnalysis: vi.fn(async () => {}),
  }
  const runner = { start: vi.fn(async () => ({ kind: 'plan' as const, subtasks: [{ seq: 1, titulo: 'Subtarefa', scope: 'Escopo', acceptanceCriteria: ['OK'], deliverables: ['Entrega'], requirementsCovered: ['REQ-1'], dependsOn: [] }], coverage: { requirements: [{ id: 'REQ-1', description: 'Requisito' }], coverage: [{ requirement: 'REQ-1', coveredBy: [1] }] } })) }
  const coordinator = new TaskCoordinator(repository, runner, bus, { operationLogger: logger, taskEvents, ...config })
  return { bus, repository, runner, coordinator, entries, eventos }
}

describe('TaskCoordinator — gate de dependência entre tarefas', () => {
  it('libera tarefa sem depends_on_task_id (comportamento inalterado)', async () => {
    const { coordinator, repository, runner, eventos } = setup(task({ dependsOnTaskId: null }))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).toHaveBeenCalledWith('task-1', expect.any(String))
    expect(runner.start).toHaveBeenCalled()
    expect(eventos.filter(e => e.evento === 'dependency_not_met')).toHaveLength(0)
  })

  it('bloqueia análise quando dependência de desenvolvimento está concluída mas sem deploy', async () => {
    const { coordinator, repository, runner, entries, eventos } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'desenvolvimento',
      dependencyTerminalStatus: 'completed',
      dependencyDeployStatus: null,
    }))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
    expect(entries.some(e => e.reasonCode === 'dependency_not_met')).toBe(true)
    expect(eventos.some(e => e.evento === 'dependency_not_met')).toBe(true)
    const evento = eventos.find(e => e.evento === 'dependency_not_met')
    expect(evento?.payload).toMatchObject({
      dependencyTaskId: 'dep-1',
      dependencyStatus: 'completed',
      dependencyDeployStatus: null,
    })
  })

  it('libera análise quando dependência de desenvolvimento está concluída E deployada', async () => {
    const { coordinator, repository, runner, eventos } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'desenvolvimento',
      dependencyTerminalStatus: 'completed',
      dependencyDeployStatus: 'succeeded',
    }))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).toHaveBeenCalled()
    expect(runner.start).toHaveBeenCalled()
    expect(eventos.filter(e => e.evento === 'dependency_not_met')).toHaveLength(0)
  })

  it('bloqueia análise quando dependência de desenvolvimento está em andamento', async () => {
    const { coordinator, repository, runner } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'desenvolvimento',
      dependencyTerminalStatus: null,
      dependencyDeployStatus: null,
    }))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('libera análise quando dependência do tipo verificacao está concluída (sem exigir deploy)', async () => {
    const { coordinator, repository, runner, eventos } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'verificacao',
      dependencyTerminalStatus: 'completed',
      dependencyDeployStatus: null,
    }))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).toHaveBeenCalled()
    expect(runner.start).toHaveBeenCalled()
    expect(eventos.filter(e => e.evento === 'dependency_not_met')).toHaveLength(0)
  })

  it('libera análise quando dependência do tipo automacao está concluída (sem exigir deploy)', async () => {
    const { coordinator, repository, runner } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'automacao',
      dependencyTerminalStatus: 'completed',
      dependencyDeployStatus: null,
    }))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).toHaveBeenCalled()
    expect(runner.start).toHaveBeenCalled()
  })

  it('bloqueia análise quando dependência do tipo verificacao NÃO está concluída', async () => {
    const { coordinator, repository, runner } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'verificacao',
      dependencyTerminalStatus: null,
      dependencyDeployStatus: null,
    }))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('mensagem TASK_RESUME_REQUESTED é consumida sem retry quando dependência não satisfeita', async () => {
    const { coordinator, bus, runner } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'desenvolvimento',
      dependencyTerminalStatus: null,
      dependencyDeployStatus: null,
    }))
    const ignored = vi.fn()
    bus.on('EVENT_TASK_IGNORED', ignored)

    // Não deve lançar erro (mensagem consumida com sucesso)
    await coordinator.handle(command())

    expect(runner.start).not.toHaveBeenCalled()
    expect(ignored).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ reason: 'dependency_not_met' }) }))
  })

  it('grava evento dependency_not_met com payload completo via TaskEventSink', async () => {
    const { coordinator, eventos } = setup(task({
      dependsOnTaskId: 'dep-42',
      dependencyTaskType: 'desenvolvimento',
      dependencyTerminalStatus: 'completed',
      dependencyDeployStatus: 'failed',
    }))

    await coordinator.handle(command())

    const evento = eventos.find(e => e.evento === 'dependency_not_met')
    expect(evento).toBeDefined()
    expect(evento?.taskId).toBe('task-1')
    expect(evento?.payload).toEqual({
      dependencyTaskId: 'dep-42',
      dependencyStatus: 'completed',
      dependencyDeployStatus: 'failed',
    })
  })

  it('registra reasonCode dependency_not_met no motor_operation_log', async () => {
    const { coordinator, entries } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'desenvolvimento',
      dependencyTerminalStatus: null,
      dependencyDeployStatus: null,
    }))

    await coordinator.handle(command())

    const depEntry = entries.find(e => e.reasonCode === 'dependency_not_met')
    expect(depEntry).toBeDefined()
    expect(depEntry?.phase).toBe('rejected')
    expect(depEntry?.outcome).toBe('rejected')
    expect(depEntry?.result).toMatchObject({ dependencyTaskId: 'dep-1' })
  })

  it('falha ao gravar evento não derruba o consumo da mensagem', async () => {
    const taskEvents = { record: vi.fn(async () => { throw new Error('db fora') }) }
    const { coordinator, runner } = setup(task({
      dependsOnTaskId: 'dep-1',
      dependencyTaskType: 'desenvolvimento',
      dependencyTerminalStatus: null,
      dependencyDeployStatus: null,
    }), { taskEvents })

    // Não deve lançar — o consumo da mensagem precisa ser bem-sucedido
    await coordinator.handle(command())

    expect(runner.start).not.toHaveBeenCalled()
  })
})
