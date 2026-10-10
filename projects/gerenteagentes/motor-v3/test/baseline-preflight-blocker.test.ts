// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MySqlDevelopmentExecutionRepository, type SubtaskExecutionContext } from '../src/execution/DevelopmentExecutionRepository.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

const context: SubtaskExecutionContext = {
  taskId: 'task-p2-939', databaseTaskId: 939, projectId: 2, subtaskId: 1273, seq: 1,
  taskTitle: 'Persistir bloqueios', taskDescription: '', title: 'Implementar persistência', scope: 'motor-v3',
  acceptanceCriteria: [], deliverables: [], projectSlug: 'gerenteagentes', repoPath: '/repo',
  baseBranch: 'base-desenvolvimento', buildCommand: 'npm run build', testCommand: 'npm test',
  agentId: 'gerenteagentes', workspacePath: null, workspaceBranch: null, workspaceBaseCommit: null,
  completionKind: 'code_change', generation: 1,
}

const source: QueueMessage = {
  messageId: 'execute-1273', type: 'SUBTASK_EXECUTION_REQUESTED', taskId: context.taskId,
  executionId: 'exec-1273', payload: { subtaskId: 1273 }, timestamp: new Date().toISOString(), attempt: 1,
}

interface QueryEntry { sql: string; params: unknown[] }

function makePoolForBlockExecution(opts: { insertAffectedRows?: number } = {}) {
  const queries: QueryEntry[] = []
  const { insertAffectedRows = 1 } = opts
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params })
    if (normalized.startsWith('UPDATE subtarefas SET status=\'blocked\'') || normalized.startsWith('UPDATE subtarefas SET status = \'blocked\'')) {
      return [{ affectedRows: 1 }]
    }
    if (normalized.startsWith('INSERT INTO bloqueios')) return [{ affectedRows: insertAffectedRows }]
    if (normalized.startsWith('SELECT id FROM bloqueios')) return [[{ id: 88 }]]
    if (normalized.startsWith('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }]
    if (normalized.includes('FROM motor_execution_wait_queue')) return [[]]
    return [[]]
  })
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query }
  return { pool: { getConnection: vi.fn().mockResolvedValue(connection) } as never, queries, connection }
}

function makePoolForBlockIncomplete(opts: {
  hasRunningSubtask?: boolean
  updateAffectedRows?: number
  insertAffectedRows?: number
  tarefaId?: number
} = {}) {
  const queries: QueryEntry[] = []
  const { hasRunningSubtask = true, updateAffectedRows = 1, insertAffectedRows = 1, tarefaId = 939 } = opts
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params })
    if (normalized.startsWith('SELECT seq, tarefa_id FROM subtarefas') || normalized.startsWith('SELECT seq , tarefa_id FROM subtarefas')) {
      return [hasRunningSubtask ? [{ seq: 1, tarefa_id: tarefaId }] : []]
    }
    if (normalized.startsWith('UPDATE subtarefas SET status=\'blocked\'') || normalized.startsWith('UPDATE subtarefas SET status = \'blocked\'')) {
      return [{ affectedRows: updateAffectedRows }]
    }
    if (normalized.startsWith('INSERT INTO bloqueios')) return [{ affectedRows: insertAffectedRows }]
    if (normalized.startsWith('SELECT id FROM bloqueios')) return [[{ id: 99 }]]
    if (normalized.startsWith('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }]
    return [[]]
  })
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query }
  return { pool: { getConnection: vi.fn().mockResolvedValue(connection) } as never, queries, connection }
}

describe('blockExecution — persistência de bloqueio + TASK_BLOCKED (incidente 939/1273)', () => {
  it('insere linha em bloqueios e publica TASK_BLOCKED em motor.monitor na mesma transação', async () => {
    const fake = makePoolForBlockExecution()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    const result = await repository.blockExecution(context, source, 'Baseline preflight failed: lint errors')

    // Verifica INSERT em bloqueios
    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert).toBeDefined()
    expect(blockerInsert!.params).toEqual(expect.arrayContaining([
      939, // databaseTaskId
      1273, // subtaskId
      'baseline_preflight_failed', // block_reason
      'SUBTASK_EXECUTION_BLOCKED', // block_command
      expect.stringContaining('"phase":"baseline_preflight"'), // block_excerpt
    ]))

    // Verifica SELECT do blockId
    const blockIdSelect = fake.queries.find(q =>
      q.sql.startsWith('SELECT id FROM bloqueios') && q.params.includes('baseline_preflight_failed'),
    )
    expect(blockIdSelect).toBeDefined()

    // Verifica TASK_BLOCKED publicado em motor.monitor
    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    expect(monitorOutbox).toBeDefined()
    expect(monitorOutbox!.params).toEqual(expect.arrayContaining([
      'TASK_BLOCKED',
      context.taskId,
      expect.stringContaining('block-baseline_preflight_failed'),
    ]))

    // Verifica que o SUBTASK_EXECUTION_BLOCKED original ainda é publicado
    const subtaskBlockedOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && !q.params.includes('motor.monitor'),
    )
    expect(subtaskBlockedOutbox).toBeDefined()
    expect(subtaskBlockedOutbox!.params).toEqual(expect.arrayContaining([
      'SUBTASK_EXECUTION_BLOCKED',
      context.taskId,
    ]))

    // Tudo na mesma transação
    expect(fake.connection.commit).toHaveBeenCalledOnce()
    expect(result.type).toBe('SUBTASK_EXECUTION_BLOCKED')
  })

  it('block_excerpt contém phase, executionId, subtaskId e erro truncado', async () => {
    const fake = makePoolForBlockExecution()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)
    const longError = 'x'.repeat(10_000)

    await repository.blockExecution(context, source, longError)

    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    const excerpt = JSON.parse(blockerInsert!.params[4] as string)
    expect(excerpt.phase).toBe('baseline_preflight')
    expect(excerpt.executionId).toBe('exec-1273')
    expect(excerpt.subtaskId).toBe(1273)
    expect(excerpt.error.length).toBeLessThanOrEqual(4_000)
  })

  it('idempotência: redelivery não duplica bloqueio nem TASK_BLOCKED', async () => {
    const fake = makePoolForBlockExecution({ insertAffectedRows: 0 })
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.blockExecution(context, source, 'Baseline preflight failed')

    // INSERT em bloqueios foi tentado
    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert).toBeDefined()

    // Mas SELECT id e TASK_BLOCKED NÃO foram executados (affectedRows=0 → early return)
    const blockIdSelect = fake.queries.find(q =>
      q.sql.startsWith('SELECT id FROM bloqueios') && q.params.includes('baseline_preflight_failed'),
    )
    expect(blockIdSelect).toBeUndefined()

    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    expect(monitorOutbox).toBeUndefined()

    // SUBTASK_EXECUTION_BLOCKED existente continua sendo publicado
    const subtaskBlocked = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('SUBTASK_EXECUTION_BLOCKED'),
    )
    expect(subtaskBlocked).toBeDefined()
  })

  it('preserva erro quando subtarefa não está running (contrato existente)', async () => {
    const queries: QueryEntry[] = []
    const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      queries.push({ sql: normalized, params })
      if (normalized.startsWith('UPDATE subtarefas SET status=\'blocked\'') || normalized.startsWith('UPDATE subtarefas SET status = \'blocked\'')) {
        return [{ affectedRows: 0 }]
      }
      return [[]]
    })
    const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query }
    const pool = { getConnection: vi.fn().mockResolvedValue(connection) } as never
    const repository = new MySqlDevelopmentExecutionRepository(pool)

    await expect(repository.blockExecution(context, source, 'any reason'))
      .rejects.toThrow(`Subtarefa ${context.subtaskId} não está em execução`)

    // Nenhum INSERT em bloqueios nem outbox deve ter sido feito
    expect(queries.some(q => q.sql.startsWith('INSERT INTO bloqueios'))).toBe(false)
    expect(queries.some(q => q.sql.startsWith('INSERT INTO motor_outbox'))).toBe(false)
    expect(connection.rollback).toHaveBeenCalled()
  })
})

describe('blockIncompleteDevelopmentSession — persistência de bloqueio + TASK_BLOCKED (incidente 939/1273)', () => {
  it('insere linha em bloqueios e publica TASK_BLOCKED em motor.monitor na mesma transação', async () => {
    const fake = makePoolForBlockIncomplete()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.blockIncompleteDevelopmentSession(
      'task-p2-939', 1273, 'exec-1273',
      'Sessão DEV encerrada 3 vez(es) sem ::DONE:: (missing_done_marker); intervenção humana necessária.',
    )

    // SELECT busca tarefa_id
    const selectQuery = fake.queries.find(q => q.sql.startsWith('SELECT seq'))
    expect(selectQuery!.sql).toContain('tarefa_id')

    // INSERT em bloqueios
    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert).toBeDefined()
    expect(blockerInsert!.params).toEqual(expect.arrayContaining([
      939, // databaseTaskId (resolvido via subtarefas.tarefa_id)
      1273, // subtaskId
      'development_completion_protocol_exhausted', // block_reason
      'SUBTASK_EXECUTION_BLOCKED', // block_command
    ]))

    // TASK_BLOCKED em motor.monitor
    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    expect(monitorOutbox).toBeDefined()
    expect(monitorOutbox!.params).toEqual(expect.arrayContaining([
      'TASK_BLOCKED',
      'task-p2-939',
    ]))

    // SUBTASK_EXECUTION_BLOCKED existente
    const subtaskBlocked = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('SUBTASK_EXECUTION_BLOCKED'),
    )
    expect(subtaskBlocked).toBeDefined()

    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('block_excerpt contém phase, executionId, subtaskId e erro truncado', async () => {
    const fake = makePoolForBlockIncomplete()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)
    const longReason = 'y'.repeat(10_000)

    await repository.blockIncompleteDevelopmentSession('task-p2-939', 1273, 'exec-1273', longReason)

    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    const excerpt = JSON.parse(blockerInsert!.params[4] as string)
    expect(excerpt.phase).toBe('development_completion_protocol')
    expect(excerpt.executionId).toBe('exec-1273')
    expect(excerpt.subtaskId).toBe(1273)
    expect(excerpt.error.length).toBeLessThanOrEqual(4_000)
  })

  it('idempotência: redelivery não duplica bloqueio nem TASK_BLOCKED', async () => {
    const fake = makePoolForBlockIncomplete({ insertAffectedRows: 0 })
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.blockIncompleteDevelopmentSession('task-p2-939', 1273, 'exec-1273', 'reason')

    // INSERT em bloqueios foi tentado
    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert).toBeDefined()

    // Mas TASK_BLOCKED NÃO foi publicado
    const monitorOutbox = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('motor.monitor'),
    )
    expect(monitorOutbox).toBeUndefined()

    // SUBTASK_EXECUTION_BLOCKED existente continua publicado
    const subtaskBlocked = fake.queries.find(q =>
      q.sql.startsWith('INSERT INTO motor_outbox') && q.params.includes('SUBTASK_EXECUTION_BLOCKED'),
    )
    expect(subtaskBlocked).toBeDefined()
  })

  it('preserva early return quando subtarefa não está running (contrato existente)', async () => {
    const fake = makePoolForBlockIncomplete({ hasRunningSubtask: false })
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.blockIncompleteDevelopmentSession('task-p2-939', 1273, 'exec-1273', 'reason')

    // Nenhum INSERT em bloqueios nem outbox
    expect(fake.queries.some(q => q.sql.startsWith('INSERT INTO bloqueios'))).toBe(false)
    expect(fake.queries.some(q => q.sql.startsWith('INSERT INTO motor_outbox'))).toBe(false)
    expect(fake.connection.rollback).toHaveBeenCalled()
  })

  it('preserva comportamento quando UPDATE não afeta linhas (status mudou entre SELECT e UPDATE)', async () => {
    const fake = makePoolForBlockIncomplete({ updateAffectedRows: 0 })
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.blockIncompleteDevelopmentSession('task-p2-939', 1273, 'exec-1273', 'reason')

    // Nenhum INSERT em bloqueios nem outbox (affectedRows=0 no UPDATE)
    expect(fake.queries.some(q => q.sql.startsWith('INSERT INTO bloqueios'))).toBe(false)
    expect(fake.queries.some(q => q.sql.startsWith('INSERT INTO motor_outbox'))).toBe(false)
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('resolve tarefa_id numérico via subtarefas (não depende de parâmetro)', async () => {
    const fake = makePoolForBlockIncomplete({ tarefaId: 12345 })
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)

    await repository.blockIncompleteDevelopmentSession('task-external-id', 1273, 'exec-1273', 'reason')

    const blockerInsert = fake.queries.find(q => q.sql.startsWith('INSERT INTO bloqueios'))
    expect(blockerInsert).toBeDefined()
    // O primeiro parâmetro do INSERT é o tarefa_id resolvido do SELECT
    expect(blockerInsert!.params[0]).toBe(12345)
  })
})
