import { describe, expect, it, vi } from 'vitest'
import { TaskExecutionReconciler } from '../src/execution/TaskExecutionReconciler.js'

type Options = {
  task?: Record<string, unknown> | null
  subtasks?: Array<Record<string, unknown>>
  orphanRunning?: Array<Record<string, unknown>>
  unfinishedCommands?: number
}

function makePool(options: Options = {}) {
  const task = options.task === undefined
    ? {
        id: 828,
        external_id: 'task-p1-828',
        tipo: 'desenvolvimento',
        paused_at: null,
        terminal_status: null,
        analysis_started_at: null,
        clarification_pending_at: null,
        blocked: 0,
        subtask_count: options.subtasks?.length ?? 0,
      }
    : options.task
  const subtasks = options.subtasks ?? []
  const orphanRunning = options.orphanRunning ?? []
  const queries: Array<{ sql: string; params?: unknown[] }> = []
  const inserted: Array<{ params?: unknown[] }> = []
  const updated: Array<{ params?: unknown[] }> = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params })
    if (normalized.includes('FROM tarefas t') && normalized.includes('FOR UPDATE')) return [task ? [task] : []]
    if (normalized.includes('FROM subtarefas s') && normalized.includes("s.status = 'running'")) return [orphanRunning]
    if (normalized.includes('FROM subtarefas s') && normalized.includes("s.status = 'pending'")) return [subtasks]
    if (normalized.includes('FROM motor_outbox o')) return [[{ total: options.unfinishedCommands ?? 0 }]]
    if (normalized.includes('INSERT INTO motor_outbox')) {
      inserted.push({ params })
      return [{ affectedRows: 1 }]
    }
    if (normalized.startsWith('UPDATE subtarefas SET status')) {
      updated.push({ params })
      return [{ affectedRows: 1 }]
    }
    throw new Error(`SQL inesperado: ${normalized}`)
  })
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    query,
  }
  return {
    pool: { query, getConnection: vi.fn(async () => connection) } as any,
    connection,
    queries,
    inserted,
    updated,
  }
}

describe('TaskExecutionReconciler', () => {
  it('enfileira execução quando há subtarefa pendente elegível', async () => {
    const fixture = makePool({
      subtasks: [{ id: 1101, seq: 6, titulo: 'Corrigir tarefa', scope: 'escopo' }],
    })

    const result = await new TaskExecutionReconciler(fixture.pool).reconcileTask('task-p1-828')

    expect(result).toEqual({ enqueued: true, type: 'TASK_READY_FOR_PROGRAMMING', taskId: 'task-p1-828' })
    expect(fixture.inserted).toHaveLength(1)
    expect(fixture.inserted[0]?.params?.[1]).toBe('TASK_READY_FOR_PROGRAMMING')
    expect(fixture.inserted[0]?.params?.[3]).toBe('task-p1-828')
    expect(fixture.connection.commit).toHaveBeenCalledOnce()
  })

  it('enfileira análise para tarefa sem plano e sem atividade em andamento', async () => {
    const fixture = makePool()

    const result = await new TaskExecutionReconciler(fixture.pool).reconcileTask('828')

    expect(result).toEqual({ enqueued: true, type: 'TASK_RESUME_REQUESTED', taskId: 'task-p1-828' })
    expect(fixture.inserted[0]?.params?.[1]).toBe('TASK_RESUME_REQUESTED')
  })

  it('não duplica comando ainda pendente ou em processamento', async () => {
    const fixture = makePool({
      subtasks: [{ id: 1101, seq: 6, titulo: 'Corrigir tarefa', scope: 'escopo' }],
      unfinishedCommands: 1,
    })

    const result = await new TaskExecutionReconciler(fixture.pool).reconcileTask('task-p1-828')

    expect(result).toEqual({ enqueued: false, reason: 'command_already_pending', taskId: 'task-p1-828' })
    expect(fixture.inserted).toHaveLength(0)
    expect(fixture.queries.find((item) => item.sql.includes('FROM motor_outbox o'))?.sql)
      .toContain('motor_message_processing_state')
  })

  it('não enfileira tarefa pausada, bloqueada ou inexistente', async () => {
    const paused = makePool({ task: { id: 828, external_id: 'task-p1-828', paused_at: new Date(), terminal_status: null, blocked: 0, subtask_count: 0 } })
    const blocked = makePool({ task: { id: 828, external_id: 'task-p1-828', paused_at: null, terminal_status: null, blocked: 1, subtask_count: 0 } })
    const missing = makePool({ task: null })

    await expect(new TaskExecutionReconciler(paused.pool).reconcileTask('828')).resolves.toMatchObject({ enqueued: false, reason: 'paused' })
    await expect(new TaskExecutionReconciler(blocked.pool).reconcileTask('828')).resolves.toMatchObject({ enqueued: false, reason: 'blocked' })
    await expect(new TaskExecutionReconciler(missing.pool).reconcileTask('828')).resolves.toMatchObject({ enqueued: false, reason: 'task_not_found' })
  })

  it('recupera subtarefa running órfã (sessão failed) e enfileira nova execução', async () => {
    const fixture = makePool({ task: { id: 828, external_id: 'task-p2-828', paused_at: null, terminal_status: null, blocked: 0, subtask_count: 6 }, orphanRunning: [{ id: 1101, seq: 6, titulo: 'Validação integrada' }] })

    const result = await new TaskExecutionReconciler(fixture.pool).reconcileTask('task-p2-828')

    expect(result).toMatchObject({ enqueued: true, type: 'TASK_READY_FOR_PROGRAMMING', taskId: 'task-p2-828' })
    expect(fixture.updated.length).toBe(1)
    expect(fixture.updated[0].params).toEqual([1101])
    expect(fixture.inserted.length).toBe(1)
  })

  it('não enfileira subtarefa running órfã se já existe comando pendente, mas reseta status', async () => {
    const fixture = makePool({ task: { id: 828, external_id: 'task-p2-828', paused_at: null, terminal_status: null, blocked: 0, subtask_count: 6 }, orphanRunning: [{ id: 1101, seq: 6, titulo: 'Validação integrada' }], unfinishedCommands: 1 })

    const result = await new TaskExecutionReconciler(fixture.pool).reconcileTask('task-p2-828')

    expect(result).toMatchObject({ enqueued: false, reason: 'command_already_pending', taskId: 'task-p2-828' })
    expect(fixture.updated.length).toBe(1) // reseta para pending mesmo assim
    expect(fixture.inserted.length).toBe(0) // mas não enfileira novo comando
  })

  it('consulta sessões ativas antes de considerar a subtarefa elegível', async () => {
    const fixture = makePool({ subtasks: [{ id: 1101, seq: 6, titulo: 'Corrigir tarefa', scope: 'escopo' }] })

    await new TaskExecutionReconciler(fixture.pool).reconcileTask('828')

    const subtaskQuery = fixture.queries.find((item) => item.sql.includes('FROM subtarefas s') && item.sql.includes("s.status = 'pending'"))
    expect(subtaskQuery?.sql).toContain('FROM motor_agent_sessions active_session')
  })
})
