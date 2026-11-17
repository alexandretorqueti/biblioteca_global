// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../src/bus/MessageBus.js'
import {
  TaskCoordinator,
  resolveDependencyBlockingReason,
  type TaskCoordinatorConfig,
  type TaskCoordinatorRepository,
  type TaskDependencySnapshot,
  type TaskSnapshot,
} from '../src/coordinator/index.js'
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

  it('exige todas as dependências e registra as que ainda bloqueiam', async () => {
    const { coordinator, repository, runner, eventos } = setup(task({
      dependencies: [
        { taskId: 'dep-1', taskType: 'verificacao', terminalStatus: 'completed', deployStatus: null },
        { taskId: 'dep-2', taskType: 'desenvolvimento', terminalStatus: 'completed', deployStatus: null },
      ],
    }))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
    expect(eventos.find(e => e.evento === 'dependency_not_met')?.payload).toMatchObject({
      dependencies: [{ taskId: 'dep-2', terminalStatus: 'completed', deployStatus: null }],
    })
  })

  it('não libera dependência de tipo desconhecido mesmo concluída', async () => {
    const { coordinator, repository, runner } = setup(task({
      dependencies: [{ taskId: 'dep-1', taskType: 'tipo_novo', terminalStatus: 'completed', deployStatus: null }],
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
    // task-p2-1071: payload enriquecido com taskType da tarefa bloqueada e
    // motivo explícito por dependência (sem nulls ambíguos).
    expect(evento?.payload).toEqual({
      taskType: 'desenvolvimento',
      dependencyTaskId: 'dep-42',
      dependencyTaskType: 'desenvolvimento',
      dependencyStatus: 'completed',
      dependencyDeployStatus: 'failed',
      dependencyReason: 'dependency_deploy_failed',
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

// task-p2-1071, subtarefa 1 — regressão do payload enriquecido de
// dependency_not_met: taskType da tarefa bloqueada + motivo explícito por
// dependência (enum fixo), sem nulls ambíguos. Paridade de gate: a decisão de
// bloqueio/liberação NÃO muda (coberta pelos testes acima, inalterados).
describe('TaskCoordinator — payload dependency_not_met enriquecido (task-p2-1071)', () => {
  function dependency(overrides: Partial<TaskDependencySnapshot> = {}): TaskDependencySnapshot {
    return { taskId: 'dep-1', taskType: 'desenvolvimento', terminalStatus: null, deployStatus: null, ...overrides }
  }

  it('resolveDependencyBlockingReason cobre cada valor do enum', () => {
    // Dependência ainda sem facts/terminal_status — raiz do falso diagnóstico
    // da tarefa 1063 (status nulo NÃO é ambíguo: não concluída).
    expect(resolveDependencyBlockingReason(dependency({ terminalStatus: null, deployStatus: null }))).toBe('dependency_not_completed')
    expect(resolveDependencyBlockingReason(dependency({ taskType: null, terminalStatus: null }))).toBe('dependency_not_completed')
    expect(resolveDependencyBlockingReason(dependency({ terminalStatus: 'running' }))).toBe('dependency_not_completed')
    // Desenvolvimento concluída com deploy falho.
    expect(resolveDependencyBlockingReason(dependency({ terminalStatus: 'completed', deployStatus: 'failed' }))).toBe('dependency_deploy_failed')
    // Desenvolvimento concluída com deploy pendente (null ou 'pending').
    expect(resolveDependencyBlockingReason(dependency({ terminalStatus: 'completed', deployStatus: null }))).toBe('dependency_deploy_pending')
    expect(resolveDependencyBlockingReason(dependency({ terminalStatus: 'completed', deployStatus: 'pending' }))).toBe('dependency_deploy_pending')
    // Tipo ausente ou não reconhecido pelo gate (concluída).
    expect(resolveDependencyBlockingReason(dependency({ taskType: null, terminalStatus: 'completed' }))).toBe('dependency_type_unknown')
    expect(resolveDependencyBlockingReason(dependency({ taskType: 'tipo_novo', terminalStatus: 'completed' }))).toBe('dependency_type_unknown')
    // Tarefa dependente inexistente no banco (LEFT JOIN sem linha).
    expect(resolveDependencyBlockingReason(dependency({ found: false, taskType: null, terminalStatus: null }))).toBe('dependency_not_found')
  })

  it('evento e motor_operation_log incluem taskType da tarefa bloqueada e dependencyReason', async () => {
    const { coordinator, entries, eventos } = setup(task({
      taskType: 'automacao',
      dependencies: [dependency({ terminalStatus: 'completed', deployStatus: null })],
    }))

    await coordinator.handle(command())

    const esperado = {
      taskType: 'automacao',
      dependencyTaskId: 'dep-1',
      dependencyTaskType: 'desenvolvimento',
      dependencyStatus: 'completed',
      dependencyDeployStatus: null,
      dependencyReason: 'dependency_deploy_pending',
    }
    expect(eventos.find(e => e.evento === 'dependency_not_met')?.payload).toMatchObject(esperado)
    expect(entries.find(e => e.reasonCode === 'dependency_not_met')?.result).toMatchObject(esperado)
  })

  it('dependência sem facts gera dependency_not_completed (incidente tarefa 1063)', async () => {
    const { coordinator, entries, eventos } = setup(task({
      taskType: 'verificacao',
      dependencies: [dependency({ taskType: 'desenvolvimento', terminalStatus: null, deployStatus: null })],
    }))

    await coordinator.handle(command())

    const payload = eventos.find(e => e.evento === 'dependency_not_met')?.payload
    expect(payload).toMatchObject({ taskType: 'verificacao', dependencyReason: 'dependency_not_completed', dependencyStatus: null })
    expect(entries.find(e => e.reasonCode === 'dependency_not_met')?.result).toMatchObject({ dependencyReason: 'dependency_not_completed' })
  })

  it('dependência inexistente gera dependency_not_found', async () => {
    const { coordinator, eventos } = setup(task({
      dependencies: [dependency({ found: false, taskType: null, terminalStatus: null })],
    }))

    await coordinator.handle(command())

    expect(eventos.find(e => e.evento === 'dependency_not_met')?.payload).toMatchObject({
      dependencyReason: 'dependency_not_found',
    })
  })

  it('deploy falho em dependência de desenvolvimento gera dependency_deploy_failed', async () => {
    const { coordinator, eventos } = setup(task({
      dependencies: [dependency({ terminalStatus: 'completed', deployStatus: 'failed' })],
    }))

    await coordinator.handle(command())

    expect(eventos.find(e => e.evento === 'dependency_not_met')?.payload).toMatchObject({
      dependencyReason: 'dependency_deploy_failed',
    })
  })

  it('tipo desconhecido concluído gera dependency_type_unknown', async () => {
    const { coordinator, eventos } = setup(task({
      dependencies: [dependency({ taskType: 'tipo_novo', terminalStatus: 'completed' })],
    }))

    await coordinator.handle(command())

    expect(eventos.find(e => e.evento === 'dependency_not_met')?.payload).toMatchObject({
      dependencyReason: 'dependency_type_unknown',
    })
  })

  it('N:N com múltiplas dependências bloqueantes lista motivo por dependência', async () => {
    const { coordinator, entries, eventos } = setup(task({
      dependencies: [
        { taskId: 'dep-1', taskType: 'desenvolvimento', terminalStatus: null, deployStatus: null },
        { taskId: 'dep-2', taskType: 'verificacao', terminalStatus: 'completed', deployStatus: null },
        { taskId: 'dep-3', taskType: 'desenvolvimento', terminalStatus: 'completed', deployStatus: 'failed' },
      ],
    }))

    await coordinator.handle(command())

    // dep-2 (verificacao concluída) não bloqueia — paridade de gate preservada.
    const esperado = [
      { taskId: 'dep-1', terminalStatus: null, reason: 'dependency_not_completed' },
      { taskId: 'dep-3', terminalStatus: 'completed', reason: 'dependency_deploy_failed' },
    ]
    expect(eventos.find(e => e.evento === 'dependency_not_met')?.payload).toMatchObject({ dependencies: esperado })
    expect(entries.find(e => e.reasonCode === 'dependency_not_met')?.result).toMatchObject({ dependencies: esperado })
  })
})
