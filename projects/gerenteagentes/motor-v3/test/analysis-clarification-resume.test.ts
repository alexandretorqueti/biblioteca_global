// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../src/bus/MessageBus.js'
import { TaskCoordinator, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
import type {
  ClarificationAnswer,
  ClarificationCheckpointRecord,
  ClarificationCheckpointStore,
} from '../src/coordinator/ClarificationCheckpoints.js'
import { ConsoleAnalystRunner, type AnalystConsole } from '../src/analysis/ConsoleAnalystRunner.js'
import type { AnalysisOutcome } from '../src/analysis/AnalystReply.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'task-1', title: 'Tarefa', description: 'Descrição integral única que NÃO deve ser reenviada XYZ-123',
    taskType: 'desenvolvimento', agentId: 'agent-1', projectSlug: 'projeto', repoPath: '/tmp/projeto',
    status: 'planned', paused: false, terminal: false, analysisStartedAt: null, subtaskCount: 0,
    ...overrides,
  }
}

const PLAN_JSON = JSON.stringify({
  subtarefas: [{
    seq: 1, titulo: 'Implementar', scope: 'Escopo', acceptance_criteria: ['OK'],
    deliverables: ['Código'], requirements_covered: ['REQ-1'], depends_on: [], completion_kind: 'code_change',
  }],
  requirements: [{ id: 'REQ-1', description: 'Requisito' }],
  coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
})
const QUESTIONS_JSON = JSON.stringify({ kind: 'perguntas', resumo: 'preciso confirmar', perguntas: ['Prefere A ou B?'] })

const planOutcome = (): AnalysisOutcome => ({
  kind: 'plan',
  subtasks: [{ seq: 1, titulo: 'Implementar', scope: 'Escopo', acceptanceCriteria: ['OK'], deliverables: ['Código'], requirementsCovered: ['REQ-1'], dependsOn: [], completionKind: 'code_change' }],
  coverage: { requirements: [{ id: 'REQ-1', description: 'Requisito' }], coverage: [{ requirement: 'REQ-1', coveredBy: [1] }] },
})
const questionsOutcome = (): AnalysisOutcome => ({ kind: 'questions', summary: 'preciso confirmar', questions: ['Prefere A ou B?'] })

/**
 * Store em memória que espelha a semântica do MySQL
 * (MySqlTaskCoordinatorRepository + ClarificationCheckpoints): append-only,
 * supersede de rodadas pendentes e fencing por resume_execution_id.
 * Compartilhado entre instâncias de coordenador para simular restart.
 */
class FakeCheckpointStore implements ClarificationCheckpointStore {
  records: Array<ClarificationCheckpointRecord & { status: string; resumeExecutionId: string | null; answerChatMessageId: number | null }> = []
  answers = new Map<number, string>()
  latestUserMessage: ClarificationAnswer | null = null
  claims: Array<{ checkpointId: number; resumeExecutionId: string }> = []
  consumed: Array<{ checkpointId: number; resumeExecutionId: string }> = []
  conflictMode = false
  private nextId = 1

  async findPendingClarificationCheckpoint(taskId: string): Promise<ClarificationCheckpointRecord | null> {
    const pending = this.records
      .filter(record => record.taskId === taskId && record.status === 'awaiting_response')
      .sort((a, b) => b.roundNumber - a.roundNumber || b.id - a.id)
    return pending[0] ?? null
  }

  async claimClarificationCheckpoint(checkpointId: number, resumeExecutionId: string, answerChatMessageId: number | null): Promise<boolean> {
    if (this.conflictMode) return false
    const record = this.records.find(item => item.id === checkpointId)
    if (!record || (record.status !== 'awaiting_response' && record.status !== 'answered')) return false
    record.status = 'answered'
    record.resumeExecutionId = resumeExecutionId
    record.answerChatMessageId = answerChatMessageId ?? record.answerChatMessageId
    this.claims.push({ checkpointId, resumeExecutionId })
    return true
  }

  async consumeClarificationCheckpoint(checkpointId: number, resumeExecutionId: string): Promise<void> {
    const record = this.records.find(item => item.id === checkpointId)
    if (record && record.status === 'answered' && record.resumeExecutionId === resumeExecutionId) {
      record.status = 'consumed'
      this.consumed.push({ checkpointId, resumeExecutionId })
    }
  }

  async findClarificationAnswer(_taskId: string, chatMessageId?: number | null): Promise<ClarificationAnswer | null> {
    if (chatMessageId != null && this.answers.has(chatMessageId)) return { chatMessageId, texto: this.answers.get(chatMessageId)! }
    return this.latestUserMessage
  }

  /** Espelha insertClarificationCheckpoint: supersede pendentes e insere nova rodada. */
  insertRound(taskId: string, executionId: string, outcome: { summary: string; questions: string[] }, session: { sessionKey: string; runtimeSessionId: string; model: string | null; modelAttempt: number; analysisAttemptId: string | null }): number {
    for (const record of this.records) {
      if (record.taskId === taskId && (record.status === 'awaiting_response' || record.status === 'answered')) record.status = 'superseded'
    }
    const roundNumber = this.records.filter(record => record.taskId === taskId).reduce((max, record) => Math.max(max, record.roundNumber), 0) + 1
    const id = this.nextId++
    this.records.push({
      id, taskId, roundNumber, sessionKey: session.sessionKey, runtimeSessionId: session.runtimeSessionId,
      model: session.model, modelAttempt: session.modelAttempt, analysisAttemptId: session.analysisAttemptId,
      analysisExecutionId: executionId, questions: outcome.questions, summary: outcome.summary,
      status: 'awaiting_response', resumeExecutionId: null, answerChatMessageId: null,
    })
    return id
  }

  /** Espelha supersedePendingClarificationCheckpoints (plano/verificação). */
  supersedePending(taskId: string): void {
    for (const record of this.records) {
      if (record.taskId === taskId && (record.status === 'awaiting_response' || record.status === 'answered')) record.status = 'superseded'
    }
  }
}

const SESSION = { sessionKey: 'analysis-model-x-task-1', runtimeSessionId: 'runtime-session-1', model: 'model-x', modelAttempt: 1, analysisAttemptId: 'attempt-1' }

function setup(opts: {
  store?: FakeCheckpointStore
  startOutcome?: AnalysisOutcome
  resumeOutcome?: AnalysisOutcome
  snapshot?: TaskSnapshot
} = {}) {
  const store = opts.store ?? new FakeCheckpointStore()
  const eventos: Array<{ evento: string; payload: Record<string, unknown> }> = []
  const taskEvents = { record: vi.fn(async (_taskId: string, evento: string, _ator: string, payload: Record<string, unknown>) => { eventos.push({ evento, payload }) }) }
  const repository: TaskCoordinatorRepository = {
    getTask: vi.fn(async () => opts.snapshot ?? task()),
    claimAnalysis: vi.fn(async () => true),
    releaseAnalysisClaim: vi.fn(async () => {}),
    // Espelha persistAnalysis do repositório MySQL: perguntas geram nova
    // rodada de checkpoint; plano/verificação superam rodadas pendentes.
    persistAnalysis: vi.fn(async (taskId: string, _executionId: string, outcome: AnalysisOutcome) => {
      if (outcome.kind === 'questions') {
        store.insertRound(taskId, _executionId, { summary: outcome.summary, questions: outcome.questions }, SESSION)
      } else {
        store.supersedePending(taskId)
      }
    }),
  }
  const runner = {
    start: vi.fn(async () => opts.startOutcome ?? planOutcome()),
    resumeClarification: vi.fn(async () => opts.resumeOutcome ?? planOutcome()),
  }
  const coordinator = new TaskCoordinator(repository, runner, new MessageBus(), { taskEvents, checkpoints: store })
  return { coordinator, repository, runner, store, eventos, taskEvents }
}

function clarificationCommand(chatMessageId = 42): QueueMessage {
  return createQueueMessage({
    type: 'TASK_RESUME_REQUESTED', taskId: 'task-1', executionId: 'clarification-source',
    payload: { reason: 'clarification_response', chatMessageId },
  })
}

describe('TaskCoordinator — retomada incremental após clarificação', () => {
  it('retoma o checkpoint persistido na mesma sessão, sem nova investigação completa', async () => {
    const store = new FakeCheckpointStore()
    store.insertRound('task-1', 'exec-analyze-round-1', { summary: 'preciso confirmar', questions: ['Prefere A ou B?'] }, SESSION)
    store.answers.set(42, 'Prefiro A')
    const { coordinator, runner, repository } = setup({ store })

    await coordinator.handle(clarificationCommand(42))

    expect(runner.start).not.toHaveBeenCalled()
    expect(runner.resumeClarification).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', status: 'awaiting_clarification' }),
      expect.stringContaining('exec-analyze-task-1-'),
      expect.objectContaining({
        roundNumber: 1,
        sessionKey: SESSION.sessionKey,
        runtimeSessionId: SESSION.runtimeSessionId,
        model: SESSION.model,
        questions: ['Prefere A ou B?'],
        answer: { chatMessageId: 42, texto: 'Prefiro A' },
      }),
    )
    expect(repository.persistAnalysis).toHaveBeenCalled()
    // Fencing: claim e consume vinculados ao executionId da retomada.
    const resumeExecutionId = vi.mocked(runner.resumeClarification).mock.calls[0][1]
    expect(store.claims).toEqual([{ checkpointId: 1, resumeExecutionId }])
    expect(store.consumed).toEqual([{ checkpointId: 1, resumeExecutionId }])
    expect(store.records[0].status).toBe('consumed')
  })

  it('registra trilha auditável da retomada (evento + execução vinculada)', async () => {
    const store = new FakeCheckpointStore()
    store.insertRound('task-1', 'exec-analyze-round-1', { summary: 's', questions: ['Q?'] }, SESSION)
    store.latestUserMessage = { chatMessageId: 43, texto: 'R' }
    const { coordinator, eventos } = setup({ store })

    await coordinator.handle(clarificationCommand(43))

    const resumed = eventos.find(event => event.evento === 'analysis_clarification_resumed')
    expect(resumed).toBeDefined()
    expect(resumed?.payload).toMatchObject({
      checkpointId: 1,
      roundNumber: 1,
      sessionKey: SESSION.sessionKey,
      runtimeSessionId: SESSION.runtimeSessionId,
      analysisExecutionId: 'exec-analyze-round-1',
      answerChatMessageId: 43,
    })
    expect(eventos.map(event => event.evento)).toContain('analysis_started')
    expect(eventos.map(event => event.evento)).toContain('analysis_completed')
  })

  it('sem checkpoint válido, reanalisa do zero com justificativa auditada', async () => {
    const { coordinator, runner, eventos } = setup()

    await coordinator.handle(clarificationCommand())

    expect(runner.resumeClarification).not.toHaveBeenCalled()
    expect(runner.start).toHaveBeenCalledWith(expect.objectContaining({ status: 'awaiting_clarification' }), expect.any(String))
    expect(eventos.some(event => event.evento === 'analysis_clarification_checkpoint_missing')).toBe(true)
  })

  it('checkpoint sem sessão vinculada exige análise completa com justificativa', async () => {
    const store = new FakeCheckpointStore()
    store.insertRound('task-1', 'exec-1', { summary: 's', questions: ['Q?'] }, { ...SESSION, runtimeSessionId: null as unknown as string })
    store.records[0].runtimeSessionId = null
    const { coordinator, runner, eventos } = setup({ store })

    await coordinator.handle(clarificationCommand())

    expect(runner.start).toHaveBeenCalled()
    expect(runner.resumeClarification).not.toHaveBeenCalled()
    expect(eventos.some(event => event.evento === 'analysis_clarification_checkpoint_unusable')).toBe(true)
  })

  it('conflito de reivindicação do checkpoint cai na análise completa (fencing)', async () => {
    const store = new FakeCheckpointStore()
    store.insertRound('task-1', 'exec-1', { summary: 's', questions: ['Q?'] }, SESSION)
    store.conflictMode = true
    const { coordinator, runner, eventos } = setup({ store })

    await coordinator.handle(clarificationCommand())

    expect(runner.resumeClarification).not.toHaveBeenCalled()
    expect(runner.start).toHaveBeenCalled()
    expect(eventos.some(event => event.evento === 'analysis_clarification_resume_conflict')).toBe(true)
  })

  it('múltiplas rodadas: novas perguntas geram rodada 2 e a segunda resposta retoma na mesma sessão', async () => {
    const store = new FakeCheckpointStore()
    store.insertRound('task-1', 'exec-original', { summary: 's1', questions: ['Pergunta 1?'] }, SESSION)
    store.answers.set(10, 'Resposta 1')
    store.answers.set(11, 'Resposta 2')
    // Rodada 1: retomada devolve novas perguntas (persistAnalysis insere rodada 2).
    const round1 = setup({ store, resumeOutcome: questionsOutcome() })
    await round1.coordinator.handle(clarificationCommand(10))

    expect(round1.runner.resumeClarification).toHaveBeenCalledTimes(1)
    expect(store.records[0].status).toBe('consumed')
    const round2 = store.records.find(record => record.roundNumber === 2)
    expect(round2?.status).toBe('awaiting_response')
    expect(round2?.questions).toEqual(['Prefere A ou B?'])
    expect(round2?.sessionKey).toBe(SESSION.sessionKey)

    // Rodada 2: nova resposta retoma o checkpoint 2 na MESMA sessão e conclui o plano.
    const round2Setup = setup({ store })
    await round2Setup.coordinator.handle(clarificationCommand(11))

    expect(round2Setup.runner.resumeClarification).toHaveBeenCalledWith(
      expect.anything(), expect.any(String),
      expect.objectContaining({ checkpointId: round2!.id, roundNumber: 2, sessionKey: SESSION.sessionKey, runtimeSessionId: SESSION.runtimeSessionId, answer: { chatMessageId: 11, texto: 'Resposta 2' } }),
    )
    expect(round2Setup.runner.start).not.toHaveBeenCalled()
    expect(store.records.find(record => record.id === round2!.id)?.status).toBe('consumed')
  })

  it('restart do Motor entre pergunta e resposta: nova instância encontra o checkpoint e retoma com fencing', async () => {
    const store = new FakeCheckpointStore()
    // Instância 1 (antes do restart): análise completa devolve perguntas.
    const before = setup({ store, startOutcome: questionsOutcome() })
    await before.coordinator.handle(createQueueMessage({ type: 'TASK_RESUME_REQUESTED', taskId: 'task-1', executionId: 'source-1', payload: {} }))

    expect(before.runner.start).toHaveBeenCalled()
    const checkpoint = store.records.find(record => record.roundNumber === 1)
    expect(checkpoint?.status).toBe('awaiting_response')
    expect(checkpoint?.analysisExecutionId).toContain('exec-analyze-task-1-')

    // --- restart do Motor: novas instâncias de coordenador/runner, mesmo banco (store) ---
    store.answers.set(99, 'Resposta pós-restart')
    const after = setup({ store })
    await after.coordinator.handle(clarificationCommand(99))

    expect(after.runner.start).not.toHaveBeenCalled()
    expect(after.runner.resumeClarification).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
      expect.stringContaining('exec-analyze-task-1-'),
      expect.objectContaining({ checkpointId: checkpoint!.id, runtimeSessionId: SESSION.runtimeSessionId, answer: { chatMessageId: 99, texto: 'Resposta pós-restart' } }),
    )
    const resumeExecutionId = vi.mocked(after.runner.resumeClarification).mock.calls[0][1]
    expect(store.claims.at(-1)).toEqual({ checkpointId: checkpoint!.id, resumeExecutionId })
    expect(store.consumed.at(-1)).toEqual({ checkpointId: checkpoint!.id, resumeExecutionId })
  })

  it('falha na retomada propaga para o retry do broker sem consumir o checkpoint', async () => {
    const store = new FakeCheckpointStore()
    store.insertRound('task-1', 'exec-1', { summary: 's', questions: ['Q?'] }, SESSION)
    store.latestUserMessage = { chatMessageId: 44, texto: 'R' }
    const { coordinator, runner, repository } = setup({ store })
    vi.mocked(runner.resumeClarification).mockRejectedValue(new Error('modelo indisponível'))

    await expect(coordinator.handle(clarificationCommand(44))).rejects.toThrow('modelo indisponível')

    expect(repository.releaseAnalysisClaim).toHaveBeenCalled()
    // Checkpoint permanece 'answered' → re-reivindicável pelo retry/restart.
    expect(store.records[0].status).toBe('answered')
    expect(store.consumed).toEqual([])
  })
})

function fakeConsole(responses: string[]): { consoleApi: AnalystConsole; sent: string[]; createSession: ReturnType<typeof vi.fn> } {
  const sent: string[] = []
  const queue = [...responses]
  const createSession = vi.fn(async () => ({ sessionId: 'runtime-new', sessionKey: 'analysis-new', agentId: 'agent-1' }))
  const consoleApi: AnalystConsole = {
    createSession,
    sendMessage: vi.fn(async ({ message }) => { sent.push(message) }),
    getSessionStatus: vi.fn(async () => ({ isComplete: true, lastResponse: queue.shift() ?? '' })),
  }
  return { consoleApi, sent, createSession }
}

const resumeInput = (overrides: Partial<Parameters<ConsoleAnalystRunner['resumeClarification']>[2]> = {}) => ({
  checkpointId: 1, roundNumber: 1, sessionKey: 'analysis-model-x-task-1', runtimeSessionId: 'runtime-session-1',
  model: 'model-x', modelAttempt: 1, analysisAttemptId: 'attempt-1', questions: ['Prefere A ou B?'],
  answer: { chatMessageId: 42, texto: 'Prefiro A' },
  ...overrides,
})

describe('ConsoleAnalystRunner — retomada de clarificação na mesma sessão', () => {
  it('continua na sessão do checkpoint sem recriar sessão nem reenviar a descrição', async () => {
    const { consoleApi, sent, createSession } = fakeConsole([PLAN_JSON])
    const onSessionResumed = vi.fn(async () => {})
    const onSessionCompleted = vi.fn(async () => {})
    const onClarificationCheckpoint = vi.fn(async () => {})
    const runner = new ConsoleAnalystRunner(consoleApi, {
      workspacePreflight: false, pollIntervalMs: 1,
      onSessionResumed, onSessionCompleted, onClarificationCheckpoint,
    })

    const outcome = await runner.resumeClarification(task(), 'exec-resume-1', resumeInput())

    expect(outcome.kind).toBe('plan')
    expect(createSession).not.toHaveBeenCalled()
    expect(consoleApi.sendMessage).toHaveBeenCalledTimes(1)
    expect(sent[0]).toContain('Prefiro A')
    expect(sent[0]).toContain('Não repita perguntas já respondidas')
    expect(sent[0]).not.toContain('XYZ-123') // descrição integral NÃO reenviada
    expect(onSessionResumed).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'runtime-session-1', sessionKey: 'analysis-model-x-task-1' }),
      expect.objectContaining({ executionId: 'exec-resume-1', phase: 'clarification_resume_claimed' }),
    )
    expect(onSessionCompleted).toHaveBeenCalled()
    expect(onClarificationCheckpoint).not.toHaveBeenCalled()
  })

  it('nova rodada de perguntas mantém a sessão aberta via onClarificationCheckpoint', async () => {
    const { consoleApi, sent } = fakeConsole([QUESTIONS_JSON])
    const onSessionCompleted = vi.fn(async () => {})
    const onClarificationCheckpoint = vi.fn(async () => {})
    const onMessageSent = vi.fn(async () => {})
    const onResponseReceived = vi.fn(async () => {})
    const runner = new ConsoleAnalystRunner(consoleApi, {
      workspacePreflight: false, pollIntervalMs: 1,
      onSessionCompleted, onClarificationCheckpoint, onMessageSent, onResponseReceived,
    })

    const outcome = await runner.resumeClarification(task(), 'exec-resume-2', resumeInput())

    expect(outcome.kind).toBe('questions')
    expect(onClarificationCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'runtime-session-1' }),
      { summary: 'preciso confirmar', questions: ['Prefere A ou B?'] },
      expect.objectContaining({ phase: 'clarification_checkpoint' }),
    )
    expect(onSessionCompleted).not.toHaveBeenCalled()
    // Auditoria append-only das mensagens da retomada.
    expect(onMessageSent).toHaveBeenCalledWith(expect.anything(), sent[0], expect.objectContaining({ messageKey: expect.stringContaining(':clarification:1') }))
    expect(onResponseReceived).toHaveBeenCalledWith(expect.anything(), QUESTIONS_JSON, expect.objectContaining({ phase: 'clarification_response' }))
  })

  it('resposta inválida recebe correção na mesma sessão antes de concluir', async () => {
    const { consoleApi, sent } = fakeConsole(['resposta sem json', PLAN_JSON])
    const runner = new ConsoleAnalystRunner(consoleApi, { workspacePreflight: false, pollIntervalMs: 1 })

    const outcome = await runner.resumeClarification(task(), 'exec-resume-3', resumeInput())

    expect(outcome.kind).toBe('plan')
    expect(consoleApi.sendMessage).toHaveBeenCalledTimes(2)
    expect(sent[1]).toContain('não atende ao contrato de análise')
  })

  it('start() com perguntas mantém a sessão aberta (checkpoint) em vez de concluir', async () => {
    const { consoleApi } = fakeConsole(['CONTEXTO_RECEBIDO', QUESTIONS_JSON])
    const onSessionCompleted = vi.fn(async () => {})
    const onClarificationCheckpoint = vi.fn(async () => {})
    const runner = new ConsoleAnalystRunner(consoleApi, {
      workspacePreflight: false, pollIntervalMs: 1, onSessionCompleted, onClarificationCheckpoint,
    })

    const outcome = await runner.start(task(), 'exec-start-1')

    expect(outcome.kind).toBe('questions')
    expect(onClarificationCheckpoint).toHaveBeenCalledWith(
      expect.anything(),
      { summary: 'preciso confirmar', questions: ['Prefere A ou B?'] },
      expect.objectContaining({ executionId: 'exec-start-1', phase: 'clarification_checkpoint' }),
    )
    expect(onSessionCompleted).not.toHaveBeenCalled()
  })

  it('falha na retomada registra onSessionFailure com fase clarification_resume', async () => {
    const { consoleApi } = fakeConsole([])
    vi.mocked(consoleApi.getSessionStatus).mockRejectedValue(new Error('Console HTTP 500'))
    const onSessionFailure = vi.fn(async () => {})
    const runner = new ConsoleAnalystRunner(consoleApi, { workspacePreflight: false, pollIntervalMs: 1, onSessionFailure })

    await expect(runner.resumeClarification(task(), 'exec-resume-4', resumeInput())).rejects.toThrow('Console HTTP 500')

    expect(onSessionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'runtime-session-1' }),
      expect.objectContaining({ message: expect.stringContaining('phase=clarification_resume') }),
      expect.objectContaining({ phase: 'clarification_resume' }),
    )
  })
})
