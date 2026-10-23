// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MySqlDevelopmentExecutionRepository } from '../src/execution/DevelopmentExecutionRepository.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

const source: QueueMessage = {
  messageId: 'ready-1', type: 'TASK_READY_FOR_PROGRAMMING', taskId: 'task-p1-100',
  executionId: 'exec-1', payload: {}, timestamp: new Date().toISOString(), attempt: 1,
}

interface PoolOptions {
  taskRow?: Array<Record<string, unknown>>
  subtaskRows?: Array<Record<string, unknown>>
  limitRows?: Array<Record<string, unknown>>
  globalCount?: number
  projectCount?: number
  reconciledCount?: { total: number; finais: number | null }
  /** Disponibilidade da cadeia DEV: enabled_total/available_total. */
  modelAvailability?: { enabled_total: number; available_total: number }
  nextAvailableAt?: Date | string | null
  sessionCount?: number
  parkUpdateAffectedRows?: number
}

function makePool(options: PoolOptions = {}) {
  const taskRow = options.taskRow ?? [{ id: 100, external_id: 'task-p1-100', projeto_id: 1, tipo: 'desenvolvimento' }]
  const subtaskRows = options.subtaskRows ?? [{ id: 501, seq: 1, titulo: 'Subtask 1', scope: 'scope' }]
  const limitRows = options.limitRows ?? [
    { chave: 'motor.max_workers', limite: 4 },
    { chave: 'motor.max_workers_per_project', limite: 2 },
  ]
  const globalCount = options.globalCount ?? 0
  const projectCount = options.projectCount ?? 0
  const reconciledCount = options.reconciledCount ?? { total: 0, finais: null }
  const modelAvailability = options.modelAvailability ?? { enabled_total: 0, available_total: 0 }
  const sessionCount = options.sessionCount ?? 0
  const parkUpdateAffectedRows = options.parkUpdateAffectedRows ?? 1

  const queries: Array<{ sql: string; params: unknown[] }> = []

  const queryFn = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalizedSql, params: params ?? [] })

    // Task lookup (reserve) / task lock (park)
    if (normalizedSql.includes('FROM tarefas t') && normalizedSql.includes('FOR UPDATE')) {
      return [taskRow]
    }
    // Reconciliation check (completeIfAllSubtasksFinal)
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes('SUM(status IN')) {
      return [[reconciledCount]]
    }
    // Limit rows
    if (normalizedSql.includes('motor_configuracoes') && normalizedSql.includes('FOR UPDATE')) {
      return [limitRows]
    }
    // Cadeia DEV: provider da primeira seleção habilitada
    if (normalizedSql.includes('SELECT model, provider FROM project_model_selection')) {
      return [[]]
    }
    // Disponibilidade da cadeia DEV (aggregate)
    if (normalizedSql.includes('AS enabled_total')) {
      return [[modelAvailability]]
    }
    // Prazo de nova elegibilidade (MIN until)
    if (normalizedSql.includes('MIN(cooldown.until) AS next_available_at')) {
      return [[{ next_available_at: options.nextAvailableAt ?? null }]]
    }
    // Sessões DEV ativas (park)
    if (normalizedSql.includes('FROM motor_agent_sessions')) {
      return [[{ total: sessionCount }]]
    }
    // Global active count
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes("'running', 'delivered', 'verifying'") && !normalizedSql.includes('projeto_id =')) {
      return [[{ total: globalCount }]]
    }
    // Project active count
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes('projeto_id =')) {
      return [[{ total: projectCount }]]
    }
    // Subtask selection
    if (normalizedSql.includes('FROM subtarefas s') && normalizedSql.includes("s.status = 'pending'")) {
      return [subtaskRows]
    }
    // UPDATE subtarefas (claim running / park pending)
    if (normalizedSql.includes('UPDATE subtarefas') && normalizedSql.includes("SET status = 'running'")) {
      return [{ affectedRows: 1 }]
    }
    if (normalizedSql.includes('UPDATE subtarefas') && normalizedSql.includes("SET status = 'pending'")) {
      return [{ affectedRows: parkUpdateAffectedRows }]
    }
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

function findQuery(queries: Array<{ sql: string; params: unknown[] }>, ...fragments: string[]) {
  return queries.find(q => fragments.every(fragment => q.sql.includes(fragment)))
}

describe('reserveNextSubtask — cooldown integral da cadeia DEV', () => {
  it('entra em espera de capacidade sem claim quando todos os modelos habilitados estão em cooldown', async () => {
    const retryAt = new Date(Date.now() + 5 * 60_000)
    const { pool, queries, connection } = makePool({
      modelAvailability: { enabled_total: 2, available_total: 0 },
      nextAvailableAt: retryAt,
    })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const result = await repo.reserveNextSubtask('task-p1-100', source)

    expect(result).toEqual({ kind: 'capacity_waiting', reason: 'model_cooldown' })
    // Espera durável: uma única entrada por tarefa (ON DUPLICATE KEY) + fato com motivo/scope/prazo
    const queueInsert = findQuery(queries, 'INSERT INTO motor_execution_wait_queue')
    expect(queueInsert).toBeDefined()
    expect(queueInsert!.sql).toContain('ON DUPLICATE KEY UPDATE')
    const factsUpdate = findQuery(queries, 'UPDATE task_runtime_facts', 'capacity_wait_reason_code')
    expect(factsUpdate).toBeDefined()
    expect(factsUpdate!.params[0]).toBe('model_cooldown')
    expect(factsUpdate!.params).toContain('model_cooldown')
    expect(factsUpdate!.params).toContain('model')
    expect(factsUpdate!.params.some(param => param instanceof Date && param.getTime() === retryAt.getTime())).toBe(true)
    // Subtarefa permanece pending: nenhum claim para running e nenhum comando de execução
    expect(findQuery(queries, 'UPDATE subtarefas', "SET status = 'running'")).toBeUndefined()
    expect(findQuery(queries, 'INSERT INTO motor_outbox')).toBeUndefined()
    expect(connection.commit).toHaveBeenCalled()
    expect(connection.rollback).not.toHaveBeenCalled()
  })

  it('reserva normalmente quando há ao menos um modelo DEV fora de cooldown', async () => {
    const { pool, queries } = makePool({
      modelAvailability: { enabled_total: 2, available_total: 1 },
    })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const result = await repo.reserveNextSubtask('task-p1-100', source)

    expect(result).not.toBeNull()
    if (!result || 'kind' in result) throw new Error('Expected ReservedSubtask')
    expect(result.subtaskId).toBe(501)
    expect(findQuery(queries, 'INSERT INTO motor_execution_wait_queue')).toBeUndefined()
  })

  it('não transforma ausência permanente de configuração em espera de capacidade', async () => {
    const { pool, queries } = makePool({
      modelAvailability: { enabled_total: 0, available_total: 0 },
    })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const result = await repo.reserveNextSubtask('task-p1-100', source)

    // Nenhum modelo habilitado/configurado: o fluxo segue para o claim e a
    // falha terminal com diagnóstico explícito permanece no consumer.
    expect(result).not.toEqual({ kind: 'capacity_waiting', reason: 'model_cooldown' })
    if (!result || 'kind' in result) throw new Error('Expected ReservedSubtask')
    expect(result.subtaskId).toBe(501)
    expect(findQuery(queries, 'INSERT INTO motor_execution_wait_queue')).toBeUndefined()
  })
})

describe('parkSubtaskForModelCooldown', () => {
  const context = {
    taskId: 'task-p1-100', databaseTaskId: 100, projectId: 1, subtaskId: 501, seq: 1,
    taskTitle: 'T', taskDescription: 'D', title: 'S', scope: 'E',
    acceptanceCriteria: [], deliverables: [], projectSlug: 'gerenteagentes',
    repoPath: '/repo', baseBranch: 'base-desenvolvimento', buildCommand: '', testCommand: '',
    agentId: 'gerenteagentes', workspacePath: null, workspaceBranch: null, workspaceBaseCommit: null,
    completionKind: 'code_change', generation: 1,
  } as any

  it('devolve a subtarefa para pending e persiste a espera com prazo, em transação', async () => {
    const retryAt = new Date(Date.now() + 10 * 60_000).toISOString()
    const { pool, queries, connection } = makePool({ nextAvailableAt: new Date(retryAt) })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const parked = await repo.parkSubtaskForModelCooldown(context, source, retryAt)

    expect(parked).toBe(true)
    const pendingUpdate = findQuery(queries, 'UPDATE subtarefas', "status = 'pending'")
    expect(pendingUpdate).toBeDefined()
    expect(pendingUpdate!.sql).toContain('provider = NULL')
    expect(pendingUpdate!.sql).toContain("AND status = 'running'")
    const queueInsert = findQuery(queries, 'INSERT INTO motor_execution_wait_queue')
    expect(queueInsert).toBeDefined()
    expect(queueInsert!.sql).toContain('ON DUPLICATE KEY UPDATE')
    const factsUpdate = findQuery(queries, 'UPDATE task_runtime_facts', 'capacity_wait_reason_code')
    expect(factsUpdate!.params[0]).toBe('model_cooldown')
    expect(factsUpdate!.params.some(param => param instanceof Date && param.toISOString() === retryAt)).toBe(true)
    // Nenhum comando de execução é emitido: a retomada passa pelo claim atômico
    expect(findQuery(queries, 'INSERT INTO motor_outbox')).toBeUndefined()
    expect(connection.commit).toHaveBeenCalled()
  })

  it('é idempotente: não muda nada quando a subtarefa já não está running', async () => {
    const { pool, queries, connection } = makePool({ parkUpdateAffectedRows: 0 })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const parked = await repo.parkSubtaskForModelCooldown(context, source, null)

    expect(parked).toBe(false)
    expect(connection.rollback).toHaveBeenCalled()
    expect(connection.commit).not.toHaveBeenCalled()
    expect(findQuery(queries, 'INSERT INTO motor_execution_wait_queue')).toBeUndefined()
  })

  it('não parkir por cima de sessão DEV ativa (sem execução concorrente)', async () => {
    const { pool, connection } = makePool({ sessionCount: 1 })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const parked = await repo.parkSubtaskForModelCooldown(context, source, null)

    expect(parked).toBe(false)
    expect(connection.rollback).toHaveBeenCalled()
    expect(connection.commit).not.toHaveBeenCalled()
  })
})

describe('wakeCapacityWaiters — guarda de cooldown', () => {
  it('não acorda espera de cooldown cujo prazo ainda não venceu', () => {
    const source = readFileSync(resolve(__dirname, '../src/execution/DevelopmentExecutionRepository.ts'), 'utf8')
    const wake = source.slice(source.indexOf('private async wakeCapacityWaiters'))
    const select = wake.slice(0, wake.indexOf('LIMIT 25 FOR UPDATE'))
    expect(select).toContain("wf.capacity_wait_reason_code = 'model_cooldown'")
    expect(select).toContain('wf.capacity_wait_retry_at > NOW()')
    expect(select).toContain('LEFT JOIN task_runtime_facts wf ON wf.tarefa_id = q.tarefa_id')
  })
})

describe('migration da espera por cooldown', () => {
  it('migration interna condicional e migration do projeto cobrem as mesmas colunas', () => {
    const internal = readFileSync(resolve(__dirname, '../drizzle/migrations/0012_dev_model_cooldown_wait.sql'), 'utf8')
    const external = readFileSync(resolve(__dirname, '../../migrations/0095_motor_capacity_wait_cooldown.sql'), 'utf8')
    for (const column of ['capacity_wait_since', 'capacity_wait_retry_at', 'capacity_wait_alert_at']) {
      expect(internal).toContain(column)
      expect(external).toContain(column)
    }
    expect(internal).toContain("'model'")
    expect(external).toContain("enum('global','project','provider','model')")
    // Idempotência da interna via prepared statement (padrão 0010)
    expect(internal).toContain('information_schema.columns')
    expect(internal).toContain('PREPARE motor_cooldown_wait_stmt')
  })
})
