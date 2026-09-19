import { describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../src/bus/MessageBus.js'
import { TaskCoordinator, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1', title: 'Tarefa', description: 'Descrição', agentId: 'agent-1',
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
  }
  const runner = { start: vi.fn(async () => {}) }
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

  it('não inicia tarefa pausada', async () => {
    const { coordinator, repository, runner, bus } = setup(task({ paused: true, status: 'paused' }))
    const ignored = vi.fn()
    bus.on('EVENT_TASK_IGNORED', ignored)

    await coordinator.handle(command())

    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
    expect(ignored).toHaveBeenCalled()
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

  it('ignora tipos de mensagem que não são comandos de análise', async () => {
    const { coordinator, repository, runner } = setup()

    await coordinator.handle(command('PROGRAMMING_COMPLETED'))

    expect(repository.getTask).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
  })
})
