import { describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../src/bus/MessageBus.js'
import { TaskCoordinator, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1', title: 'Tarefa', description: 'Descrição', taskType: 'desenvolvimento', agentId: 'agent-1',
    projectSlug: 'projeto', repoPath: '/tmp/projeto', status: 'planned', paused: false,
    terminal: false, analysisStartedAt: null, subtaskCount: 0, ...overrides,
  }
}

function command(type = 'TASK_RESUME_REQUESTED'): QueueMessage {
  return createQueueMessage({ type, taskId: 'task-1', executionId: 'source-exec', payload: {} })
}

function setup(snapshot: TaskSnapshot | null = task()) {
  const bus = new MessageBus()
  const repository: TaskCoordinatorRepository = {
    getTask: vi.fn(async () => snapshot),
    claimAnalysis: vi.fn(async () => true),
    releaseAnalysisClaim: vi.fn(async () => {}),
    persistAnalysis: vi.fn(async () => {}),
  }
  const runner = { start: vi.fn(async () => ({ kind: 'plan' as const, subtasks: [{ seq: 1, titulo: 'Subtarefa', scope: 'Escopo', acceptanceCriteria: ['OK'], deliverables: ['Entrega'], requirementsCovered: ['REQ-1'], dependsOn: [] }], coverage: { requirements: [{ id: 'REQ-1', description: 'Requisito' }], coverage: [{ requirement: 'REQ-1', coveredBy: [1] }] } })) }
  const coordinator = new TaskCoordinator(repository, runner, bus)
  return { bus, repository, runner, coordinator }
}

describe('TaskCoordinator', () => {
  it('seleciona e inicia uma análise para tarefa planejada', async () => {
    const { coordinator, repository, runner, bus } = setup()
    const events: string[] = []
    bus.on('EVENT_ANALYSIS_SELECTED', message => events.push(message.type))
    bus.on('EVENT_ANALYSIS_STARTED', message => events.push(message.type))

    await coordinator.handle(command())

    expect(repository.claimAnalysis).toHaveBeenCalledWith('task-1', expect.stringContaining('exec-analyze-task-1-'))
    expect(runner.start).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }), expect.any(String))
    expect(events).toEqual(['EVENT_ANALYSIS_SELECTED', 'EVENT_ANALYSIS_STARTED'])
  })

  it('usa o prompt de retomada quando a resposta de clarificação chega por mensagem', async () => {
    const { coordinator, runner } = setup(task({ status: 'planned' }))
    const resume = createQueueMessage({
      type: 'TASK_RESUME_REQUESTED', taskId: 'task-1', executionId: 'clarification-1',
      payload: { reason: 'clarification_response', chatMessageId: 42 },
    })

    await coordinator.handle(resume)

    expect(runner.start).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'awaiting_clarification' }),
      expect.any(String),
    )
  })

  it('não inicia tarefa pausada', async () => {
    const { coordinator, repository, runner, bus } = setup(task({ paused: true, status: 'paused' }))
    const ignored = vi.fn()
    bus.on('EVENT_TASK_IGNORED', ignored)

    await coordinator.handle(command())

    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
    expect(ignored).toHaveBeenCalled()
  })

  it.each(['TASK_CREATED', 'TASK_ENQUEUED'])('não inicia análise com %s', async (type) => {
    const { coordinator, repository, runner } = setup()

    await coordinator.handle(command(type))

    expect(repository.getTask).not.toHaveBeenCalled()
    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('não repete análise quando o plano já existe', async () => {
    const { coordinator, repository, runner, bus } = setup(task({ subtaskCount: 2 }))
    const ready = vi.fn()
    bus.on('EVENT_TASK_READY_FOR_PROGRAMMING', ready)

    await coordinator.handle(command())

    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
    expect(ready).toHaveBeenCalled()
  })

  it('não inicia quando o claim atômico falha', async () => {
    const setupResult = setup()
    vi.mocked(setupResult.repository.claimAnalysis).mockResolvedValue(false)
    const ignored = vi.fn()
    setupResult.bus.on('EVENT_TASK_IGNORED', ignored)

    await setupResult.coordinator.handle(command())

    expect(setupResult.runner.start).not.toHaveBeenCalled()
    expect(ignored).toHaveBeenCalled()
  })

  it('libera o claim e propaga falha do runner', async () => {
    const { coordinator, repository, runner, bus } = setup()
    vi.mocked(runner.start).mockRejectedValue(new Error('Console indisponível'))
    const failed = vi.fn()
    bus.on('EVENT_ANALYSIS_FAILED', failed)

    await expect(coordinator.handle(command())).rejects.toThrow('Console indisponível')

    expect(repository.releaseAnalysisClaim).toHaveBeenCalledWith('task-1', expect.any(String))
    expect(failed).toHaveBeenCalled()
  })

  it('propaga falha ao persistir TASK_READY_FOR_PROGRAMMING para permitir retry da fila', async () => {
    const { bus, repository, runner } = setup()
    const publishTaskReady = vi.fn().mockRejectedValue(new Error('outbox indisponível'))
    const coordinator = new TaskCoordinator(repository, runner, bus, { publishTaskReady })

    await expect(coordinator.handle(command())).rejects.toThrow('outbox indisponível')

    expect(publishTaskReady).toHaveBeenCalledWith(expect.objectContaining({ type: 'TASK_RESUME_REQUESTED' }), expect.objectContaining({ subtaskCount: 1 }))
  })

  it('ignora tipos de mensagem que não são comandos de análise', async () => {
    const { coordinator, repository, runner } = setup()

    await coordinator.handle(command('PROGRAMMING_COMPLETED'))

    expect(repository.getTask).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
  })
})
// @vitest-environment node
