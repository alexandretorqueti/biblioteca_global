import { describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../src/bus/MessageBus.js'
import { TaskCoordinator, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
import type { CommandPolicyRepository, OperationLogEntry, OperationLogger } from '../src/commands/index.js'
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

/** Setup com gate de políticas governado (espelho da produção: C03/P03/A21). */
function setupGoverned(snapshot: TaskSnapshot | null = task()) {
  const bus = new MessageBus()
  const entries: OperationLogEntry[] = []
  const logger: OperationLogger = { append: vi.fn(async entry => { entries.push(entry) }) }
  const policies: CommandPolicyRepository = {
    findByMessageType: vi.fn(async () => ({
      command: { code: 'C03_TASK_RESUME_REQUESTED', active: true, version: 1 },
      policies: [{ code: 'P03_RESUME_IF_ELIGIBLE', priority: 100, conditions: ['task_not_paused', 'task_not_terminal', 'task_not_blocked', 'task_has_no_subtasks', 'analysis_not_claimed'], actionCode: 'A21_RESUME_TASK_ANALYSIS', active: true, version: 1 }],
    })),
  }
  const repository: TaskCoordinatorRepository = {
    getTask: vi.fn(async () => snapshot),
    claimAnalysis: vi.fn(async () => true),
    releaseAnalysisClaim: vi.fn(async () => {}),
    persistAnalysis: vi.fn(async () => {}),
  }
  const runner = { start: vi.fn(async () => ({ kind: 'plan' as const, subtasks: [{ seq: 1, titulo: 'Subtarefa', scope: 'Escopo', acceptanceCriteria: ['OK'], deliverables: ['Entrega'], requirementsCovered: ['REQ-1'], dependsOn: [] }], coverage: { requirements: [{ id: 'REQ-1', description: 'Requisito' }], coverage: [{ requirement: 'REQ-1', coveredBy: [1] }] } })) }
  const coordinator = new TaskCoordinator(repository, runner, bus, { commandPolicies: policies, operationLogger: logger })
  return { bus, repository, runner, coordinator, entries }
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

  it('recupera claim órfão quando a mesma mensagem volta após queda', async () => {
    const resume = command()
    const orphanExecution = `exec-analyze-task-1-${resume.messageId}-attempt-1`
    const { coordinator, repository, runner } = setup(task({
      status: 'running', analysisStartedAt: new Date().toISOString(), analysisExecutionId: orphanExecution,
    }))

    await coordinator.handle(resume)

    expect(repository.releaseAnalysisClaim).toHaveBeenCalledWith('task-1', orphanExecution)
    expect(repository.claimAnalysis).toHaveBeenCalled()
    expect(runner.start).toHaveBeenCalled()
  })

  it('libera claim órfão ANTES do gate de políticas quando a mesma mensagem volta (incidente 862)', async () => {
    const resume = command()
    const orphanExecution = `exec-analyze-task-1-${resume.messageId}-attempt-1`
    const { coordinator, repository, runner } = setupGoverned(task({
      status: 'analyzing', analysisStartedAt: new Date().toISOString(), analysisExecutionId: orphanExecution,
    }))

    await coordinator.handle(resume)

    // Sem a correção, a política P03 rejeitaria com analysis_already_claimed
    // antes da recuperação do claim órfão e a análise nunca seria refeita.
    expect(repository.releaseAnalysisClaim).toHaveBeenCalledWith('task-1', orphanExecution)
    expect(repository.claimAnalysis).toHaveBeenCalled()
    expect(runner.start).toHaveBeenCalled()
  })

  it('registra a liberação do claim órfão como primitiva no operation log', async () => {
    const resume = command()
    const orphanExecution = `exec-analyze-task-1-${resume.messageId}-attempt-1`
    const { coordinator, entries } = setupGoverned(task({
      status: 'analyzing', analysisStartedAt: new Date().toISOString(), analysisExecutionId: orphanExecution,
    }))

    await coordinator.handle(resume)

    expect(entries.some(entry => entry.primitiveCode === 'release_orphan_analysis_claim')).toBe(true)
    const sequences = entries.map(entry => entry.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('mantém a rejeição da política para claim de outra execução (messageId diferente)', async () => {
    const { coordinator, repository, runner, entries } = setupGoverned(task({
      status: 'analyzing', analysisStartedAt: new Date().toISOString(),
      analysisExecutionId: 'exec-analyze-task-1-outro-message-id-attempt-1',
    }))

    await coordinator.handle(command())

    expect(repository.releaseAnalysisClaim).not.toHaveBeenCalled()
    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
    expect(entries.some(entry => entry.reasonCode === 'analysis_already_claimed')).toBe(true)
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
