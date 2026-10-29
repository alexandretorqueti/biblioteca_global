// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  MySqlDevelopmentExecutionRepository,
  subtaskExecutionCorrelation,
} from '../src/execution/DevelopmentExecutionRepository.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

/**
 * Regressão do incidente task-p2-1048/subtarefa 1447 (2026-10-29):
 *
 * A chave lógica do outbox `(type, task_id, correlation_id)` é única e a
 * correlação propaga pela cadeia da tarefa (TASK_RESUME → TASK_READY →
 * SER → SVR → SUBTASK_VERIFIED → próximo SER). O `completeVerification`
 * da subtarefa 1447 tentou inserir o SUBTASK_EXECUTION_REQUESTED da
 * subtarefa seguinte com a MESMA correlação do SER da 1447 →
 * ER_DUP_ENTRY em `motor_outbox_logical_key_unique` → rollback → 3
 * tentativas → bloqueio terminal `subtask_verification_failed`.
 *
 * A correção escopa a correlação do SER por subtarefa (`<raiz>:sub:<id>`),
 * mesmo padrão do `:gate:<jobId>` do TestGateOrchestrator.
 */

const ROOT = '6285e645-66bd-4aef-9cd1-be81a2717f6f'

const readySource: QueueMessage = {
  messageId: 'ready-1', type: 'TASK_READY_FOR_PROGRAMMING', taskId: 'task-p2-1048',
  executionId: 'exec-ready-1', correlationId: ROOT, payload: {},
  timestamp: new Date().toISOString(), attempt: 1,
}

function makePool(options: {
  subtaskRows?: Array<Record<string, unknown>>
} = {}) {
  const subtaskRows = options.subtaskRows ?? [{ id: 501, seq: 1, titulo: 'Subtask 1', scope: 'scope' }]
  const queries: Array<{ sql: string; params: unknown[] }> = []

  const queryFn = vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalizedSql, params: params ?? [] })

    if (normalizedSql.includes('FROM tarefas t') && normalizedSql.includes('FOR UPDATE') && !normalizedSql.includes('subtarefas')) {
      return [[{ id: 1048, external_id: 'task-p2-1048', projeto_id: 640, tipo: 'desenvolvimento' }]]
    }
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes('SUM(status IN')) {
      return [[{ total: 0, finais: null }]]
    }
    if (normalizedSql.includes('terminal_status') && normalizedSql.includes('task_runtime_facts') && normalizedSql.includes('FOR UPDATE')) {
      return [[]]
    }
    if (normalizedSql.includes('AS has_integrated_code')) {
      return [[{ has_integrated_code: 0 }]]
    }
    if (normalizedSql.includes('motor_configuracoes') && normalizedSql.includes('FOR UPDATE')) {
      return [[
        { chave: 'motor.max_workers', limite: 4 },
        { chave: 'motor.max_workers_per_project', limite: 2 },
      ]]
    }
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes("'running', 'delivered', 'verifying'") && !normalizedSql.includes('projeto_id =')) {
      return [[{ total: 0 }]]
    }
    if (normalizedSql.includes('COUNT(*) AS total') && normalizedSql.includes('projeto_id =')) {
      return [[{ total: 0 }]]
    }
    if (normalizedSql.includes('FROM subtarefas s') && normalizedSql.includes("s.status = 'pending'")) {
      return [subtaskRows]
    }
    if (normalizedSql.includes('UPDATE subtarefas') && (normalizedSql.includes("status = 'running'") || normalizedSql.includes("status = 'verified'"))) {
      return [{ affectedRows: 1 }]
    }
    if (normalizedSql.includes('DELETE FROM motor_execution_wait_queue')) {
      return [{ affectedRows: 0 }]
    }
    if (normalizedSql.includes('INSERT INTO motor_outbox')) {
      return [{ affectedRows: 1 }]
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

function outboxInserts(queries: Array<{ sql: string; params: unknown[] }>, type: string) {
  return queries.filter(q => q.sql.includes('INSERT INTO motor_outbox') && String(q.params[1]) === type)
}

describe('subtaskExecutionCorrelation — escopo por subtarefa na chave lógica do outbox', () => {
  it('deriva <raiz>:sub:<id> preservando a raiz da correlação', () => {
    expect(subtaskExecutionCorrelation({ correlationId: ROOT, messageId: 'm1' }, 1448)).toBe(`${ROOT}:sub:1448`)
  })

  it('não acumula sufixos ao longo da cadeia (extrai a raiz antes do primeiro ":")', () => {
    expect(subtaskExecutionCorrelation({ correlationId: `${ROOT}:sub:1447`, messageId: 'm1' }, 1448)).toBe(`${ROOT}:sub:1448`)
    expect(subtaskExecutionCorrelation({ correlationId: `${ROOT}:gate:1006`, messageId: 'm1' }, 1448)).toBe(`${ROOT}:sub:1448`)
  })

  it('usa o messageId como raiz quando a correlação está ausente', () => {
    expect(subtaskExecutionCorrelation({ correlationId: null, messageId: 'msg-9' }, 7)).toBe('msg-9:sub:7')
  })

  it('limita o resultado a 200 caracteres (tamanho da coluna)', () => {
    const longRoot = 'r'.repeat(400)
    expect(subtaskExecutionCorrelation({ correlationId: longRoot, messageId: 'm1' }, 1).length).toBeLessThanOrEqual(200)
  })
})

describe('reserveNextSubtask — SER com correlação escopada (incidente task-p2-1048)', () => {
  it('insere SUBTASK_EXECUTION_REQUESTED com <raiz>:sub:<subtaskId>, não a correlação bruta da cadeia', async () => {
    const { pool, queries } = makePool({ subtaskRows: [{ id: 1447, seq: 1, titulo: 'S1', scope: 'sc' }] })
    const repo = new MySqlDevelopmentExecutionRepository(pool)

    const result = await repo.reserveNextSubtask('task-p2-1048', readySource)

    expect(result).not.toBeNull()
    if (!result || 'kind' in result) throw new Error('Expected ReservedSubtask')
    const inserts = outboxInserts(queries, 'SUBTASK_EXECUTION_REQUESTED')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].params[6]).toBe(`${ROOT}:sub:1447`)
    expect(result.message.correlationId).toBe(`${ROOT}:sub:1447`)
  })

  it('duas subtarefas distintas da mesma cadeia geram chaves lógicas distintas', async () => {
    const first = makePool({ subtaskRows: [{ id: 1447, seq: 1, titulo: 'S1', scope: 'sc' }] })
    const r1 = await new MySqlDevelopmentExecutionRepository(first.pool).reserveNextSubtask('task-p2-1048', readySource)
    const second = makePool({ subtaskRows: [{ id: 1448, seq: 2, titulo: 'S2', scope: 'sc' }] })
    const r2 = await new MySqlDevelopmentExecutionRepository(second.pool).reserveNextSubtask('task-p2-1048', readySource)

    const key1 = outboxInserts(first.queries, 'SUBTASK_EXECUTION_REQUESTED')[0].params[6]
    const key2 = outboxInserts(second.queries, 'SUBTASK_EXECUTION_REQUESTED')[0].params[6]
    expect(key1).toBe(`${ROOT}:sub:1447`)
    expect(key2).toBe(`${ROOT}:sub:1448`)
    expect(key1).not.toBe(key2)
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
  })
})

describe('completeVerification → reserveNextSubtaskInTransaction (caminho exato do incidente)', () => {
  const verificationSource: QueueMessage = {
    messageId: 'svr-1447', type: 'SUBTASK_VERIFICATION_REQUESTED', taskId: 'task-p2-1048',
    executionId: 'exec-subtask-task-p2-1048-1447-1', correlationId: `${ROOT}:sub:1447`,
    causationId: 'sec-1447', payload: { subtaskId: 1447, seq: 1 },
    timestamp: new Date().toISOString(), attempt: 1,
  }

  it('o SER da próxima subtarefa não reusa a chave lógica do SER anterior', async () => {
    const { pool, queries } = makePool({ subtaskRows: [{ id: 1448, seq: 2, titulo: 'S2', scope: 'sc' }] })
    const repo = new MySqlDevelopmentExecutionRepository(pool)
    const context = {
      taskId: 'task-p2-1048', databaseTaskId: 1048, projectId: 640, subtaskId: 1447, seq: 1,
    } as any

    const { verified, next } = await repo.completeVerification(context, verificationSource, {
      commitSha: 'abc123', integrationCommitSha: 'def456',
    })

    // SUBTASK_VERIFIED da 1447 herda a correlação escopada da própria cadeia.
    const verifiedInserts = outboxInserts(queries, 'SUBTASK_VERIFIED')
    expect(verifiedInserts).toHaveLength(1)
    expect(verifiedInserts[0].params[6]).toBe(`${ROOT}:sub:1447`)

    // O SER da subtarefa seguinte (1448) precisa de chave lógica própria —
    // antes da correção reusava a correlação da cadeia e colidia com o SER
    // da 1447 já persistido (ER_DUP_ENTRY → bloqueio terminal).
    const serInserts = outboxInserts(queries, 'SUBTASK_EXECUTION_REQUESTED')
    expect(serInserts).toHaveLength(1)
    expect(serInserts[0].params[6]).toBe(`${ROOT}:sub:1448`)
    expect(serInserts[0].params[6]).not.toBe(verifiedInserts[0].params[6])

    expect(verified.type).toBe('SUBTASK_VERIFIED')
    expect(next.type).toBe('SUBTASK_EXECUTION_REQUESTED')
    expect(next.correlationId).toBe(`${ROOT}:sub:1448`)
  })
})
