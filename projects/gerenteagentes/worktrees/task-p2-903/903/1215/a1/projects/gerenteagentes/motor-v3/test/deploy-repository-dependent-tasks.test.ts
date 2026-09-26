import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DeployRepository } from '../src/deploy/DeployRepository.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { createQueueMessage } from '../src/queue/index.js'

/**
 * Testes para retomada automática de tarefas dependentes após deploy bem-sucedido.
 * Subtarefa 2 da tarefa T0 — Governança Motor v3.
 */

type QueryCall = { sql: string; params: unknown[] }

function mockPool(): { pool: Pool; connection: PoolConnection; queries: QueryCall[] } {
  const queries: QueryCall[] = []
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      // Mock responses based on query type
      if (sql.includes('UPDATE deploy_batches')) {
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT t.external_id,dr.tarefa_id')) {
        return [[{ external_id: 'task-1', task_id: 1 }]]
      }
      if (sql.includes('UPDATE deploy_requests SET status')) {
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT t.id, t.external_id') && sql.includes('depends_on_task_id')) {
        // Return dependent tasks based on test scenario
        return [[]]
      }
      return [[]]
    }),
  } as unknown as PoolConnection
  
  const pool = {
    getConnection: vi.fn(async () => connection),
  } as unknown as Pool
  
  return { pool, connection, queries }
}

describe('DeployRepository — retomada automática de tarefas dependentes', () => {
  let repo: DeployRepository
  let pool: Pool
  let connection: PoolConnection
  let queries: QueryCall[]

  beforeEach(() => {
    const mocks = mockPool()
    pool = mocks.pool
    connection = mocks.connection
    queries = mocks.queries
    repo = new DeployRepository(pool, '/tmp/worktrees')
  })

  it('completeBatch com success=true consulta tarefas dependentes elegíveis', async () => {
    const source = createQueueMessage({
      type: 'DEPLOY_BATCH_SUCCEEDED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { batchId: 'batch-1' },
    })

    await repo.completeBatch('batch-1', true, null, source)

    // Verify that findDependentTasks was called (query with depends_on_task_id)
    const dependentQuery = queries.find(q => q.sql.includes('depends_on_task_id IN'))
    expect(dependentQuery).toBeDefined()
    expect(dependentQuery?.sql).toContain('paused_at IS NULL')
    expect(dependentQuery?.sql).toContain('terminal_status IS NULL')
    expect(dependentQuery?.sql).toContain('analysis_started_at IS NULL')
  })

  it('completeBatch com success=false NÃO consulta tarefas dependentes', async () => {
    const source = createQueueMessage({
      type: 'DEPLOY_BATCH_FAILED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { batchId: 'batch-1' },
    })

    await repo.completeBatch('batch-1', false, 'Deploy falhou', source)

    // Verify that findDependentTasks was NOT called
    const dependentQuery = queries.find(q => q.sql.includes('depends_on_task_id IN'))
    expect(dependentQuery).toBeUndefined()
  })

  it('não retoma tarefa com paused_at definido (pausa de usuário)', async () => {
    // Mock a dependent task with paused_at set
    const connectionQuery = connection.query as ReturnType<typeof vi.fn>
    connectionQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      if (sql.includes('depends_on_task_id IN')) {
        // Return empty array (no eligible tasks because paused_at is set)
        return [[]]
      }
      if (sql.includes('UPDATE deploy_batches')) {
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT t.external_id,dr.tarefa_id')) {
        return [[{ external_id: 'task-1', task_id: 1 }]]
      }
      return [[]]
    })

    const source = createQueueMessage({
      type: 'DEPLOY_BATCH_SUCCEEDED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { batchId: 'batch-1' },
    })

    await repo.completeBatch('batch-1', true, null, source)

    // Verify the query checks for paused_at IS NULL
    const dependentQuery = queries.find(q => q.sql.includes('depends_on_task_id IN'))
    expect(dependentQuery?.sql).toContain('paused_at IS NULL')
  })

  it('não retoma tarefa terminal (terminal_status não nulo)', async () => {
    const connectionQuery = connection.query as ReturnType<typeof vi.fn>
    connectionQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      if (sql.includes('depends_on_task_id IN')) {
        return [[]]
      }
      if (sql.includes('UPDATE deploy_batches')) {
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT t.external_id,dr.tarefa_id')) {
        return [[{ external_id: 'task-1', task_id: 1 }]]
      }
      return [[]]
    })

    const source = createQueueMessage({
      type: 'DEPLOY_BATCH_SUCCEEDED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { batchId: 'batch-1' },
    })

    await repo.completeBatch('batch-1', true, null, source)

    // Verify the query checks for terminal_status IS NULL
    const dependentQuery = queries.find(q => q.sql.includes('depends_on_task_id IN'))
    expect(dependentQuery?.sql).toContain('terminal_status IS NULL')
  })

  it('não retoma tarefa já em análise (analysis_started_at não nulo)', async () => {
    const connectionQuery = connection.query as ReturnType<typeof vi.fn>
    connectionQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      if (sql.includes('depends_on_task_id IN')) {
        return [[]]
      }
      if (sql.includes('UPDATE deploy_batches')) {
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT t.external_id,dr.tarefa_id')) {
        return [[{ external_id: 'task-1', task_id: 1 }]]
      }
      return [[]]
    })

    const source = createQueueMessage({
      type: 'DEPLOY_BATCH_SUCCEEDED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { batchId: 'batch-1' },
    })

    await repo.completeBatch('batch-1', true, null, source)

    // Verify the query checks for analysis_started_at IS NULL
    const dependentQuery = queries.find(q => q.sql.includes('depends_on_task_id IN'))
    expect(dependentQuery?.sql).toContain('analysis_started_at IS NULL')
  })

  it('não retoma tarefa com subtarefas (subtask_count > 0)', async () => {
    const connectionQuery = connection.query as ReturnType<typeof vi.fn>
    connectionQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      if (sql.includes('depends_on_task_id IN')) {
        return [[]]
      }
      if (sql.includes('UPDATE deploy_batches')) {
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT t.external_id,dr.tarefa_id')) {
        return [[{ external_id: 'task-1', task_id: 1 }]]
      }
      return [[]]
    })

    const source = createQueueMessage({
      type: 'DEPLOY_BATCH_SUCCEEDED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { batchId: 'batch-1' },
    })

    await repo.completeBatch('batch-1', true, null, source)

    // Verify the query checks for subtask_count = 0
    const dependentQuery = queries.find(q => q.sql.includes('depends_on_task_id IN'))
    expect(dependentQuery?.sql).toContain('COUNT(*) FROM subtarefas')
  })

  it('publica TASK_RESUME_REQUESTED no outbox para cada dependente elegível', async () => {
    const connectionQuery = connection.query as ReturnType<typeof vi.fn>
    connectionQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      if (sql.includes('depends_on_task_id IN')) {
        // Return 2 eligible dependent tasks
        return [[
          { id: 2, external_id: 'task-2' },
          { id: 3, external_id: 'task-3' },
        ]]
      }
      if (sql.includes('UPDATE deploy_batches')) {
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT t.external_id,dr.tarefa_id')) {
        return [[{ external_id: 'task-1', task_id: 1 }]]
      }
      return [[]]
    })

    const source = createQueueMessage({
      type: 'DEPLOY_BATCH_SUCCEEDED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { batchId: 'batch-1' },
    })

    await repo.completeBatch('batch-1', true, null, source)

    // Verify that TASK_RESUME_REQUESTED messages were inserted
    const outboxInserts = queries.filter(q => q.sql.includes('INSERT INTO motor_outbox'))
    const resumeMessages = outboxInserts.filter(q => q.params.some(param => typeof param === 'string' && param.includes('TASK_RESUME_REQUESTED')))
    expect(resumeMessages.length).toBe(2) // One for each dependent task
  })

  it('retomada é idempotente: não duplica mensagens para o mesmo batch', async () => {
    const connectionQuery = connection.query as ReturnType<typeof vi.fn>
    connectionQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] })
      if (sql.includes('depends_on_task_id IN')) {
        // The NOT EXISTS clause should prevent duplicates
        return [[]]
      }
      if (sql.includes('UPDATE deploy_batches')) {
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SELECT t.external_id,dr.tarefa_id')) {
        return [[{ external_id: 'task-1', task_id: 1 }]]
      }
      return [[]]
    })

    const source = createQueueMessage({
      type: 'DEPLOY_BATCH_SUCCEEDED',
      taskId: 'task-1',
      executionId: 'exec-1',
      payload: { batchId: 'batch-1' },
    })

    await repo.completeBatch('batch-1', true, null, source)

    // Verify the query includes NOT EXISTS for idempotency
    const dependentQuery = queries.find(q => q.sql.includes('depends_on_task_id IN'))
    expect(dependentQuery?.sql).toContain('NOT EXISTS')
    expect(dependentQuery?.sql).toContain('motor_outbox')
    expect(dependentQuery?.sql).toContain('TASK_RESUME_REQUESTED')
  })
})
