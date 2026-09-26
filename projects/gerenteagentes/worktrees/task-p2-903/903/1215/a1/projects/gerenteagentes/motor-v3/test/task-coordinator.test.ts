import { describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../src/bus/MessageBus.js'
import { TaskCoordinator, type TaskCoordinatorConfig, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
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

function setup(snapshot: TaskSnapshot | null = task(), config: TaskCoordinatorConfig = {}) {
  const bus = new MessageBus()
  const repository: TaskCoordinatorRepository = {
    getTask: vi.fn(async () => snapshot),
    claimAnalysis: vi.fn(async () => true),
    releaseAnalysisClaim: vi.fn(async () => {}),
    persistAnalysis: vi.fn(async () => {}),
  }
  const runner = { start: vi.fn(async () => ({ kind: 'plan' as const, subtasks: [{ seq: 1, titulo: 'Subtarefa', scope: 'Escopo', acceptanceCriteria: ['OK'], deliverables: ['Entrega'], requirementsCovered: ['REQ-1'], dependsOn: [] }], coverage: { requirements: [{ id: 'REQ-1', description: 'Requisito' }], coverage: [{ requirement: 'REQ-1', coveredBy: [1] }] } })) }
  const coordinator = new TaskCoordinator(repository, runner, bus, config)
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

  it('mantém lease durável durante a análise e o remove ao terminar', async () => {
    const { bus, repository, runner } = setup()
    const lease = {
      acquireAnalysisLease: vi.fn(async () => undefined),
      heartbeatAnalysisLease: vi.fn(async () => undefined),
      releaseAnalysisLease: vi.fn(async () => undefined),
    }
    Object.assign(repository, lease)
    const coordinator = new TaskCoordinator(repository, runner, bus, { analysisLeaseTtlMs: 90_000 })

    await coordinator.handle(command())

    expect(lease.acquireAnalysisLease).toHaveBeenCalledWith('task-1', expect.stringContaining('exec-analyze-task-1-'), 90_000)
    expect(vi.mocked(runner.start).mock.invocationCallOrder[0]).toBeGreaterThan(lease.acquireAnalysisLease.mock.invocationCallOrder[0])
    expect(lease.releaseAnalysisLease).toHaveBeenCalledWith(expect.stringContaining('exec-analyze-task-1-'))
  })

  it('libera lease e claim quando não consegue adquirir a presença durável', async () => {
    const { bus, repository, runner } = setup()
    const lease = {
      acquireAnalysisLease: vi.fn(async () => { throw new Error('lease indisponível') }),
      heartbeatAnalysisLease: vi.fn(async () => undefined),
      releaseAnalysisLease: vi.fn(async () => undefined),
    }
    Object.assign(repository, lease)
    const coordinator = new TaskCoordinator(repository, runner, bus)

    await expect(coordinator.handle(command())).rejects.toThrow('lease indisponível')

    expect(runner.start).not.toHaveBeenCalled()
    expect(repository.releaseAnalysisClaim).toHaveBeenCalledWith('task-1', expect.any(String))
    expect(lease.releaseAnalysisLease).toHaveBeenCalledWith(expect.any(String))
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

  it('preserva claim recuperável quando a mesma mensagem volta após queda', async () => {
    const resume = command()
    const { coordinator, repository, runner } = setup(task({
      status: 'running', analysisStartedAt: new Date().toISOString(), analysisExecutionId: `exec-analyze-task-1-${resume.messageId}-attempt-1`,
    }))

    await coordinator.handle(resume)

    expect(repository.releaseAnalysisClaim).not.toHaveBeenCalled()
    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('não reabre análise no consumidor quando a recuperação de sessão está pendente', async () => {
    const resume = command()
    const { coordinator, repository, runner } = setupGoverned(task({
      status: 'analyzing', analysisStartedAt: new Date().toISOString(), analysisExecutionId: `exec-analyze-task-1-${resume.messageId}-attempt-1`,
    }))

    await coordinator.handle(resume)

    expect(repository.releaseAnalysisClaim).not.toHaveBeenCalled()
    expect(repository.claimAnalysis).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('registra a análise recuperável como rejeição sem liberar o claim', async () => {
    const resume = command()
    const { coordinator, entries } = setupGoverned(task({
      status: 'analyzing', analysisStartedAt: new Date().toISOString(), analysisExecutionId: `exec-analyze-task-1-${resume.messageId}-attempt-1`,
    }))

    await coordinator.handle(resume)

    expect(entries.some(entry => entry.reasonCode === 'analysis_already_claimed')).toBe(true)
    expect(entries.some(entry => entry.primitiveCode === 'release_orphan_analysis_claim')).toBe(false)
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

  describe('falha de análise e auditoria (incidente 862, itens 2 e 6)', () => {
    it('na tentativa final persiste bloqueio, registra eventos e propaga o erro', async () => {
      const analysisFailure = { blockForAnalysisFailure: vi.fn(async () => {}) }
      const eventos: { evento: string; payload?: Record<string, unknown> | null }[] = []
      const taskEvents = { record: vi.fn(async (_taskId: string, evento: string, _ator?: string, payload?: Record<string, unknown> | null) => { eventos.push({ evento, payload }) }) }
      const { coordinator, runner } = setup(task(), { analysisFailure, taskEvents, maxAnalysisAttempts: 3 })
      vi.mocked(runner.start).mockRejectedValue(new Error('Console indisponível'))

      await expect(coordinator.handle({ ...command(), attempt: 3 })).rejects.toThrow('Console indisponível')

      expect(analysisFailure.blockForAnalysisFailure).toHaveBeenCalledWith('task-1', expect.objectContaining({ attempt: 3, error: 'Console indisponível' }))
      expect(eventos.map(e => e.evento)).toEqual(['analysis_started', 'analysis_failed'])
      expect(eventos[1].payload).toMatchObject({ final: true, attempt: 3 })
    })

    it('tentativa transitória não bloqueia: segue para o retry do broker', async () => {
      const analysisFailure = { blockForAnalysisFailure: vi.fn(async () => {}) }
      const { coordinator, runner } = setup(task(), { analysisFailure, maxAnalysisAttempts: 3 })
      vi.mocked(runner.start).mockRejectedValue(new Error('timeout'))

      await expect(coordinator.handle(command())).rejects.toThrow('timeout')

      expect(analysisFailure.blockForAnalysisFailure).not.toHaveBeenCalled()
    })

    it('falha ao persistir o bloqueio não esconde o erro original da análise', async () => {
      const analysisFailure = { blockForAnalysisFailure: vi.fn(async () => { throw new Error('db indisponível') }) }
      const { coordinator, runner } = setup(task(), { analysisFailure, maxAnalysisAttempts: 1 })
      vi.mocked(runner.start).mockRejectedValue(new Error('Console indisponível'))

      await expect(coordinator.handle(command())).rejects.toThrow('Console indisponível')

      expect(analysisFailure.blockForAnalysisFailure).toHaveBeenCalled()
    })

    it('registra analysis_started e analysis_completed no caminho feliz', async () => {
      const eventos: { evento: string; ator?: string }[] = []
      const taskEvents = { record: vi.fn(async (_taskId: string, evento: string, ator?: string) => { eventos.push({ evento, ator }) }) }
      const { coordinator } = setup(task(), { taskEvents })

      await coordinator.handle(command())

      expect(eventos.map(e => e.evento)).toEqual(['analysis_started', 'analysis_completed'])
      expect(eventos.every(e => e.ator === 'motor')).toBe(true)
    })

    it('registra analysis_clarification quando o analista devolve perguntas', async () => {
      const eventos: string[] = []
      const taskEvents = { record: vi.fn(async (_taskId: string, evento: string) => { eventos.push(evento) }) }
      const { coordinator, runner } = setup(task(), { taskEvents })
      vi.mocked(runner.start).mockResolvedValue({ kind: 'questions', summary: 'preciso confirmar', questions: ['ok?'] })

      await coordinator.handle(command())

      expect(eventos).toEqual(['analysis_started', 'analysis_clarification'])
    })

    it('falha de auditoria não derruba o fluxo principal', async () => {
      const taskEvents = { record: vi.fn(async () => { throw new Error('db fora') }) }
      const { coordinator, runner } = setup(task(), { taskEvents })

      await coordinator.handle(command())

      expect(runner.start).toHaveBeenCalled()
    })
  })

  it('ignora tipos de mensagem que não são comandos de análise', async () => {
    const { coordinator, repository, runner } = setup()

    await coordinator.handle(command('PROGRAMMING_COMPLETED'))

    expect(repository.getTask).not.toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
  })
})
// @vitest-environment node
