import { describe, expect, it, vi } from 'vitest'
import { ConsoleAnalystRunner, type AnalystConsole, type AnalystSession } from '../src/analysis/ConsoleAnalystRunner.js'
import { MessageBus } from '../src/bus/MessageBus.js'
import { TaskCoordinator, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
import { createQueueMessage } from '../src/queue/index.js'
import type { GovernedFailureHandler } from '../src/governance/GovernedFailureHandler.js'

const plan = JSON.stringify({
  subtarefas: [{ seq: 1, titulo: 'Implementar', scope: 'Escopo', acceptance_criteria: ['OK'], deliverables: ['Código'], requirements_covered: ['REQ-1'], depends_on: [] }],
  requirements: [{ id: 'REQ-1', description: 'Requisito' }],
  coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
})

const task: TaskSnapshot = {
  taskId: 'task-analysis', title: 'Análise', description: 'Descrição', taskType: 'desenvolvimento',
  agentId: 'agent-1', projectSlug: 'projeto', repoPath: '/tmp/projeto', status: 'planned',
  paused: false, terminal: false, analysisStartedAt: null, subtaskCount: 0,
}

function session(id: string): AnalystSession {
  return { sessionId: id, sessionKey: `analysis-model-${id}`, agentId: task.agentId }
}

function consoleWithStatuses(statuses: Array<{ isComplete: boolean; isFailed?: boolean; lastResponse?: string; error?: string }>): AnalystConsole {
  let index = 0
  return {
    createSession: vi.fn(async ({ model }: { model?: string }) => session(model ?? 'default')),
    sendMessage: vi.fn(async () => undefined),
    getSessionStatus: vi.fn(async () => statuses[Math.min(index++, statuses.length - 1)]!),
  }
}

function nonTerminalGovernedResult() {
  return {
    governed: true,
    classification: { event: { code: 'E02' }, occurrence: 1, reaction: { id: 1 }, action: { id: 2, code: 'A02', isTerminal: false } },
    action: { actionCode: 'A02', success: true, primitivesExecuted: ['cooldown_model'], compensated: false },
  }
}

describe('governança do fluxo de análise', () => {
  it('mantém H2 legado quando o handler não está configurado', async () => {
    const api = consoleWithStatuses([
      { isComplete: true, lastResponse: 'CONTEXTO_RECEBIDO' },
      { isComplete: false, isFailed: true, error: 'modelo indisponível' },
      { isComplete: true, lastResponse: 'CONTEXTO_RECEBIDO' },
      { isComplete: true, lastResponse: plan },
    ])
    const modelFailureRecorder = vi.fn(async () => undefined)
    const runner = new ConsoleAnalystRunner(api, {
      modelChainResolver: async () => ['model-a', 'model-b'],
      modelFailureRecorder,
      pollIntervalMs: 1,
    })

    await expect(runner.start(task, 'execution-1')).resolves.toMatchObject({ kind: 'plan' })
    expect(modelFailureRecorder).toHaveBeenCalledTimes(1)
  })

  it('roteia H2 ao catálogo e mantém fallback para o próximo modelo', async () => {
    const api = consoleWithStatuses([
      { isComplete: true, lastResponse: 'CONTEXTO_RECEBIDO' },
      { isComplete: false, isFailed: true, error: 'modelo indisponível' },
      { isComplete: true, lastResponse: 'CONTEXTO_RECEBIDO' },
      { isComplete: true, lastResponse: plan },
    ])
    const handler = { handleFailure: vi.fn(async () => nonTerminalGovernedResult()) }
    const modelFailureRecorder = vi.fn(async () => undefined)
    const runner = new ConsoleAnalystRunner(api, {
      modelChainResolver: async () => ['model-a', 'model-b'],
      modelFailureRecorder,
      governedFailureHandler: handler as unknown as GovernedFailureHandler,
      pollIntervalMs: 1,
    })

    await expect(runner.start(task, 'execution-1')).resolves.toMatchObject({ kind: 'plan' })
    expect(handler.handleFailure).toHaveBeenCalledWith('analysis_model_fallback', expect.objectContaining({ model: 'model-a' }), expect.objectContaining({ code: 'model_unavailable' }))
    expect(modelFailureRecorder).not.toHaveBeenCalled()
  })

  it('roteia H3 como resposta inválida após a correção do mesmo modelo', async () => {
    const api = consoleWithStatuses([
      { isComplete: true, lastResponse: 'CONTEXTO_RECEBIDO' },
      { isComplete: true, lastResponse: '{invalido' },
      { isComplete: true, lastResponse: '{continua-invalido' },
      { isComplete: true, lastResponse: 'CONTEXTO_RECEBIDO' },
      { isComplete: true, lastResponse: plan },
    ])
    const handler = { handleFailure: vi.fn(async () => nonTerminalGovernedResult()) }
    const runner = new ConsoleAnalystRunner(api, {
      modelChainResolver: async () => ['model-a', 'model-b'],
      governedFailureHandler: handler as unknown as GovernedFailureHandler,
      pollIntervalMs: 1,
    })

    await expect(runner.start(task, 'execution-1')).resolves.toMatchObject({ kind: 'plan' })
    expect(handler.handleFailure).toHaveBeenCalledWith('analysis_invalid_reply', expect.anything(), expect.objectContaining({ code: 'invalid_json' }))
  })

  it('encerra H4 quando uma reação terminal do catálogo é executada', async () => {
    const api = consoleWithStatuses([
      { isComplete: true, lastResponse: 'CONTEXTO_RECEBIDO' },
      { isComplete: false, isFailed: true, error: 'timeout aguardando análise' },
    ])
    const handler = {
      handleFailure: vi.fn(async () => ({
        governed: true,
        classification: { event: { code: 'E03' }, occurrence: 2, reaction: { id: 2 }, action: { id: 3, code: 'A03', isTerminal: true } },
        action: { actionCode: 'A03', success: true, primitivesExecuted: ['block_task'], compensated: false },
      })),
    }
    const runner = new ConsoleAnalystRunner(api, {
      modelChainResolver: async () => ['model-a', 'model-b'],
      governedFailureHandler: handler as unknown as GovernedFailureHandler,
      pollIntervalMs: 1,
    })

    await expect(runner.start(task, 'execution-1')).rejects.toThrow('timeout aguardando análise')
    expect(api.createSession).toHaveBeenCalledTimes(1)
  })

  it('H1 usa bloqueio legado com flag desligada e não duplica bloqueio após ação terminal', async () => {
    const repository: TaskCoordinatorRepository = {
      getTask: vi.fn(async () => task),
      claimAnalysis: vi.fn(async () => true),
      releaseAnalysisClaim: vi.fn(async () => undefined),
      persistAnalysis: vi.fn(async () => undefined),
    }
    const runner = { start: vi.fn(async () => { throw new Error('Console indisponível') }) }
    const analysisFailure = { blockForAnalysisFailure: vi.fn(async () => undefined) }
    const terminalHandler = {
      handleFailure: vi.fn(async () => ({
        governed: true,
        classification: { event: { code: 'E41' }, occurrence: 2, reaction: { id: 2 }, action: { id: 3, code: 'A03', isTerminal: true } },
        action: { actionCode: 'A03', success: true, primitivesExecuted: ['block_task'], compensated: false },
      })),
    }
    const coordinator = new TaskCoordinator(repository, runner, new MessageBus(), {
      analysisFailure,
      maxAnalysisAttempts: 1,
      governedFailureHandler: terminalHandler as unknown as GovernedFailureHandler,
    })

    await expect(coordinator.handle({ ...createQueueMessage({ type: 'TASK_RESUME_REQUESTED', taskId: task.taskId, payload: {} }), attempt: 1 })).rejects.toThrow('Console indisponível')
    expect(terminalHandler.handleFailure).toHaveBeenCalledWith('analysis_terminal', expect.objectContaining({ taskId: task.taskId }), expect.objectContaining({ code: 'ANALYSIS_FAILED' }))
    expect(analysisFailure.blockForAnalysisFailure).not.toHaveBeenCalled()
  })
})
