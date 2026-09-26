import { describe, expect, it, vi } from 'vitest'
import { TaskAdjustmentConsumer, TASK_ADJUSTMENT_REQUESTED } from '../src/adjustment/TaskAdjustmentConsumer.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'
import type { AnalysisOutcome } from '../src/analysis/AnalystReply.js'

function makeMessage(overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    messageId: 'adj-1',
    type: TASK_ADJUSTMENT_REQUESTED,
    taskId: 'task-p1-100',
    executionId: 'exec-adj-1',
    payload: { message: 'Corrigir cor do botão', generation: 2 },
    timestamp: new Date().toISOString(),
    attempt: 1,
    ...overrides,
  }
}

function makePool(options: {
  taskRow?: Record<string, unknown>
  genRow?: Record<string, unknown>
  subtaskRows?: Array<Record<string, unknown>>
  insertResult?: { insertId: number }
} = {}) {
  const taskRow = options.taskRow ?? {
    id: 100, external_id: 'task-p1-100', titulo: 'Tarefa original',
    descricao: 'Descrição original', tipo: 'desenvolvimento',
    project_slug: 'admin-global', agent_id: 'admin-global', repo_path: '/repo',
  }
  const genRow = options.genRow ?? { max_generation: 1 }
  const subtaskRows = options.subtaskRows ?? [
    { seq: 1, titulo: 'Subtarefa gen 1', status: 'verified', generation: 1, workspace_commit_sha: 'abc12345' },
  ]
  const insertResult = options.insertResult ?? { insertId: 1 }

  const queryFn = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim()
    // Task lookup
    if (normalizedSql.includes('FROM tarefas t') && normalizedSql.includes('projetos_captados')) {
      return [taskRow ? [taskRow] : []]
    }
    // Max generation
    if (normalizedSql.includes('MAX(generation)') && normalizedSql.includes('subtarefas')) {
      return [[genRow]]
    }
    // Previous subtasks
    if (normalizedSql.includes('FROM subtarefas') && normalizedSql.includes('generation <')) {
      return [subtaskRows]
    }
    // INSERT tarefa_chats
    if (normalizedSql.includes('INSERT INTO tarefa_chats')) {
      return [{ insertId: 1, affectedRows: 1 }]
    }
    // UPDATE task_runtime_facts
    if (normalizedSql.includes('UPDATE task_runtime_facts')) {
      return [{ affectedRows: 1 }]
    }
    // INSERT subtarefas
    if (normalizedSql.includes('INSERT INTO subtarefas')) {
      return [insertResult]
    }
    // UPDATE subtarefas (dependencies)
    if (normalizedSql.includes('UPDATE subtarefas SET depends_on')) {
      return [{ affectedRows: 1 }]
    }
    // Default
    return [{}]
  })

  return {
    query: queryFn,
    getConnection: vi.fn().mockReturnValue({
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      query: queryFn,
    }),
  }
}

function makeAnalyst(outcome: AnalysisOutcome) {
  return {
    start: vi.fn().mockResolvedValue(outcome),
  }
}

describe('TaskAdjustmentConsumer', () => {
  it('ignora mensagens de outro tipo', async () => {
    const pool = makePool() as any
    const analyst = makeAnalyst({ kind: 'plan', subtasks: [], coverage: { requirements: [], coverage: [] } })
    const consumer = new TaskAdjustmentConsumer(pool, analyst as any)
    const message = makeMessage({ type: 'DEPLOY_REQUESTED' })
    await consumer.handle(message)
    expect(analyst.start).not.toHaveBeenCalled()
  })

  it('monta prompt com contexto completo e cria subtarefas com generation correta', async () => {
    const pool = makePool() as any
    const planOutcome: AnalysisOutcome = {
      kind: 'plan',
      subtasks: [{
        seq: 1, titulo: 'Corrigir cor do botão',
        scope: 'Componente Button', acceptanceCriteria: ['Cor correta'],
        deliverables: ['Button.tsx'], requirementsCovered: ['R1'],
        dependsOn: [],
      }],
      coverage: { requirements: [{ id: 'R1', description: 'Cor do botão' }], coverage: [{ requirement: 'R1', coveredBy: [1] }] },
    }
    const analyst = makeAnalyst(planOutcome)
    const consumer = new TaskAdjustmentConsumer(pool, analyst as any)
    const message = makeMessage()

    await consumer.handle(message)

    // O analista foi chamado
    expect(analyst.start).toHaveBeenCalledTimes(1)
    const snapshot = analyst.start.mock.calls[0][0]
    expect(snapshot.taskId).toBe('task-p1-100')
    expect(snapshot.status).toBe('deployed')
    // O prompt inclui contexto de generation
    expect(snapshot.description).toContain('Generation 2')
    expect(snapshot.description).toContain('Corrigir cor do botão')
    expect(snapshot.description).toContain('Subtarefas das generations anteriores')

    // Mensagem do usuário registrada no chat
    const chatInsertCalls = pool.query.mock.calls.filter(
      (call: any[]) => String(call[0]).includes('INSERT INTO tarefa_chats')
    )
    expect(chatInsertCalls.length).toBeGreaterThanOrEqual(2) // user message + analyst response

    // Subtarefas criadas com generation = 2
    const subtaskInsertCalls = pool.query.mock.calls.filter(
      (call: any[]) => String(call[0]).includes('INSERT INTO subtarefas')
    )
    expect(subtaskInsertCalls.length).toBe(1)
    // O parâmetro de generation é o 10º parâmetro (index 9)
    const insertParams = subtaskInsertCalls[0][1]
    expect(insertParams[9]).toBe(2) // generation
  })

  it('retorna sem erro quando a tarefa não é encontrada', async () => {
    // Mock direto que retorna array vazio para simular tarefa inexistente
    const queryFn = vi.fn().mockResolvedValue([[]])
    const pool = {
      query: queryFn,
      getConnection: vi.fn().mockReturnValue({
        beginTransaction: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn(),
        query: queryFn,
      }),
    } as any
    const analyst = makeAnalyst({ kind: 'plan', subtasks: [], coverage: { requirements: [], coverage: [] } })
    const consumer = new TaskAdjustmentConsumer(pool, analyst as any)
    const message = makeMessage()

    await consumer.handle(message)

    expect(analyst.start).not.toHaveBeenCalled()
  })

  it('registra perguntas no chat quando analista retorna perguntas', async () => {
    const pool = makePool() as any
    const questionsOutcome: AnalysisOutcome = {
      kind: 'questions',
      summary: 'Preciso de mais detalhes',
      questions: ['Qual cor exata?'],
    }
    const analyst = makeAnalyst(questionsOutcome)
    const consumer = new TaskAdjustmentConsumer(pool, analyst as any)
    const message = makeMessage()

    await consumer.handle(message)

    expect(analyst.start).toHaveBeenCalledTimes(1)
    // Mensagem do analista registrada como perguntas
    const chatInsertCalls = pool.query.mock.calls.filter(
      (call: any[]) => String(call[0]).includes('INSERT INTO tarefa_chats')
    )
    // user message + analyst questions
    expect(chatInsertCalls.length).toBe(2)
  })
})
