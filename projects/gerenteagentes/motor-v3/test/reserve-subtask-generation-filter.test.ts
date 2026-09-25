import { describe, expect, it, vi } from 'vitest'
import { MySqlDevelopmentExecutionRepository } from '../src/execution/DevelopmentExecutionRepository.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

const source: QueueMessage = {
  messageId: 'ready-1', type: 'TASK_READY_FOR_PROGRAMMING', taskId: 'task-p1-100',
  executionId: 'exec-1', payload: {}, timestamp: new Date().toISOString(), attempt: 1,
}

function makePool(options: {
  taskRow?: Array<Record<string, unknown>>
  subtaskRows?: Array<Record<string, unknown>>
  limitRows?: Array<Record<string, unknown>>
  globalCount?: number
  projectCount?: number
  reconciledCount?: { total: number; finais: number | null }
  factRow?: Array<Record<string, unknown>>
} = {}) {
  const taskRow = options.taskRow ?? [{ id: 100, external_id: 'task-p1-100', projeto_id: 1, tipo: 'desenvolvimento' }]
  const subtaskRows = options.subtaskRows ?? [{ id: 501, seq: 1, titulo: 'Subtask 1', scope: 'scope' }]
  const limitRows = options.limitRows ?? [
    { chave: 'motor.max_workers', limite: 4 },
    { chave: 'motor.max_workers_per_project', limite: 2 },
  ]
  const globalCount = options.globalCount ?? 0
  const projectCount = options.projectCount ?? 0
  const reconciledCount = options.reconciledCount ?? { total: 0, finais: null }
  const factRow = options.factRow ?? []

  const queries: Array<{ sql: string; params: unknown[] }> = []

  const queryFn = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalizedSql, params: params ?? [] })

    // Task lookup
    if (normalizedSql.includes('FROM tarefas t') && normalizedSql.includes('FOR UPDATE') && !normalizedSql.includes('subtarefas')) {
      return [taskRow]
    }
    // Reconciliation check (completeIfAllSubtasksFinal)
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes('SUM(status IN')) {
      return [[reconciledCount]]
    }
    // Fact check for reconciliation
    if (normalizedSql.includes('terminal_status') && normalizedSql.includes('task_runtime_facts') && normalizedSql.includes('FOR UPDATE')) {
      return [factRow]
    }
    // Limit rows
    if (normalizedSql.includes('motor_configuracoes') && normalizedSql.includes('FOR UPDATE')) {
      return [limitRows]
    }
    // Global active count
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes("'running', 'delivered', 'verifying'") && !normalizedSql.includes('projeto_id =')) {
      return [[{ total: globalCount }]]
    }
    // Project active count
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes('projeto_id =')) {
      return [[{ total: projectCount }]]
    }
    // Subtask selection (the key query we're testing)
    if (normalizedSql.includes('FROM subtarefas s') && normalizedSql.includes("s.status = 'pending'")) {
      return [subtaskRows]
    }
    // UPDATE subtarefas status
    if (normalizedSql.includes('UPDATE subtarefas') && normalizedSql.includes("status = 'running'")) {
      return [{ affectedRows: 1 }]
    }
    // DELETE wait queue
    if (normalizedSql.includes('DELETE FROM motor_execution_wait_queue')) {
      return [{ affectedRows: 0 }]
    }
    // INSERT outbox
    if (normalizedSql.includes('INSERT INTO motor_outbox')) {
      return [{ affectedRows: 1 }]
    }
    // Default
    return [{}]
  })

  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: queryFn,
  }

  return {
    pool: {
      query: queryFn,
      getConnection: vi.fn().mockResolvedValue(connection),
    } as any,
    queries,
    connection,
  }
}

describe('reserveNextSubtask — filtro de generation', () => {
  it('filtra subtarefas pela generation máxima na query principal', async () => {
    const { pool, queries } = makePool()
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const result = await repo.reserveNextSubtask('task-p1-100', source)

    expect(result).not.toBeNull()
    if (!result || 'kind' in result) throw new Error('Expected ReservedSubtask')

    // Encontrar a query de seleção de subtarefas
    const subtaskQuery = queries.find(q =>
      q.sql.includes('FROM subtarefas s') && q.sql.includes("s.status = 'pending'")
    )
    expect(subtaskQuery).toBeDefined()
    // Verificar que contém o filtro de generation máxima
    expect(subtaskQuery!.sql).toContain('s.generation = (')
    expect(subtaskQuery!.sql).toContain('SELECT MAX(s2.generation)')
    expect(subtaskQuery!.sql).toContain('WHERE s2.tarefa_id = s.tarefa_id')
  })

  it('escopa a verificação de previous para a mesma generation', async () => {
    const { pool, queries } = makePool()
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    await repo.reserveNextSubtask('task-p1-100', source)

    const subtaskQuery = queries.find(q =>
      q.sql.includes('FROM subtarefas s') && q.sql.includes("s.status = 'pending'")
    )
    expect(subtaskQuery).toBeDefined()
    // O NOT EXISTS de previous deve incluir filtro de generation
    expect(subtaskQuery!.sql).toContain('previous.generation = s.generation')
  })

  it('retorna subtarefa quando há subtarefas pendentes na generation máxima', async () => {
    const { pool } = makePool({
      subtaskRows: [{ id: 601, seq: 1, titulo: 'Ajuste gen 2', scope: 'Escopo ajuste' }],
    })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const result = await repo.reserveNextSubtask('task-p1-100', source)

    expect(result).not.toBeNull()
    if (!result || 'kind' in result) throw new Error('Expected ReservedSubtask')
    expect(result.subtaskId).toBe(601)
    expect(result.seq).toBe(1)
  })

  it('retorna null quando não há subtarefas pendentes', async () => {
    const { pool } = makePool({ subtaskRows: [] })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const result = await repo.reserveNextSubtask('task-p1-100', source)

    expect(result).toBeNull()
  })
})
