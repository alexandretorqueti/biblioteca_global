// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { TestGateOrchestrator } from '../src/testing/TestGateOrchestrator.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'
import type { TestGateInput } from '../src/testing/TestGateService.js'

/**
 * Incidente 2026-10-27 (tarefa custom-gestao-recorrencias, batch
 * deploy-5ecea42f): o fluxo de deploy enfileira DOIS gates pre_deploy para a
 * mesma tarefa dentro da mesma correlação — o gate do accept (DEPLOY_REQUESTED)
 * e o gate do batch composto (dispatch). TEST_RUN_COMPLETED e o dispatch
 * herdam o correlationId da cadeia, e a chave lógica do outbox
 * (type, task_id, correlation_id) rejeitava o segundo INSERT com
 * ER_DUP_ENTRY 'TEST_RUN_REQUESTED-<task>-<correlation>', falhando o lote e
 * bloqueando a tarefa com deploy_failed.
 *
 * A correção deriva o correlation_id da mensagem de gate por job
 * (`<correlação-base>:gate:<jobId>`): mantém a rastreabilidade da cadeia e
 * garante unicidade na chave lógica, enquanto a deduplicação de reentrega
 * continua em test_gate_jobs.request_message_id.
 */

interface CapturedQuery { sql: string; params: unknown[] }

interface FakeJob { insertId: number; affectedRows: number; existingId?: number }

function fakePool(jobs: FakeJob[]): { pool: Pool; queries: CapturedQuery[]; state: { committed: number; rolledBack: number } } {
  const queries: CapturedQuery[] = []
  const state = { committed: 0, rolledBack: 0 }
  let jobIndex = 0
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => { state.committed++ }),
    rollback: vi.fn(async () => { state.rolledBack++ }),
    release: vi.fn(() => {}),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql: String(sql), params: params ?? [] })
      if (String(sql).includes('INSERT IGNORE INTO test_gate_jobs')) {
        const job = jobs[jobIndex++] ?? { insertId: 0, affectedRows: 0 }
        return [{ insertId: job.insertId, affectedRows: job.affectedRows } as ResultSetHeader, []]
      }
      if (String(sql).includes('SELECT id FROM test_gate_jobs')) {
        const job = jobs[jobIndex - 1]
        const rows = job?.existingId ? [{ id: job.existingId } as RowDataPacket & { id: number }] : []
        return [rows, []]
      }
      return [{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []]
    }),
  } as unknown as PoolConnection
  const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool
  return { pool, queries, state }
}

const gateInput: TestGateInput = {
  projectId: 13, taskDatabaseId: 1024, phase: 'pre_deploy',
  commitSha: 'abc123', baseCommitSha: 'def456', branchName: 'base-desenvolvimento',
  workspacePath: '/tmp/integration', buildCommand: 'npm run build', testCommand: 'npm test',
} as TestGateInput

function sourceMessage(messageId: string, correlationId?: string): QueueMessage {
  return createQueueMessage({
    messageId,
    type: 'DEPLOY_REQUESTED', taskId: 'custom-gestao-recorrencias',
    executionId: `exec-${messageId}`, payload: {},
    ...(correlationId ? { correlationId } : {}),
  })
}

function outboxInserts(queries: CapturedQuery[]): CapturedQuery[] {
  return queries.filter(q => q.sql.includes('INSERT INTO motor_outbox'))
}

describe('TestGateOrchestrator — chave lógica do outbox', () => {
  it('dois gates da mesma cadeia (accept + batch composto) produzem correlation_id distintos por job', async () => {
    const fake = fakePool([
      { insertId: 988, affectedRows: 1 },
      { insertId: 989, affectedRows: 1 },
    ])
    const orchestrator = new TestGateOrchestrator(fake.pool)

    // Mesma correlação herdada da cadeia (cenário real do incidente): o
    // dispatch carrega o correlationId do DEPLOY_REQUESTED retomado.
    const correlation = 'c5aa1b0f-aa88-4ef8-9053-b7d2b30b409d'
    const jobId1 = await orchestrator.enqueue(gateInput, sourceMessage('3973ea3f-msg', correlation))
    const jobId2 = await orchestrator.enqueue(gateInput, sourceMessage('59a34d66-msg', correlation))

    expect(jobId1).toBe(988)
    expect(jobId2).toBe(989)

    const inserts = outboxInserts(fake.queries)
    expect(inserts).toHaveLength(2)
    // correlation_id é o 7º parâmetro do INSERT no outbox (timestamp é NOW()).
    const correlations = inserts.map(i => String(i.params[6]))
    expect(correlations[0]).toBe(`${correlation}:gate:988`)
    expect(correlations[1]).toBe(`${correlation}:gate:989`)
    expect(new Set(correlations).size).toBe(2)
    // A chave lógica (type, task_id, correlation_id) não colide mais.
    const logicalKeys = inserts.map(i => `${i.params[1]}-${i.params[3]}-${i.params[6]}`)
    expect(new Set(logicalKeys).size).toBe(2)
    // message_id segue deduplicável por origem+fase (request_message_id).
    expect(inserts[0]!.params[0]).toBe('3973ea3f-msg:pre_deploy:task')
    expect(inserts[1]!.params[0]).toBe('59a34d66-msg:pre_deploy:task')
    // Causation mantém o rastreio da mensagem de origem.
    expect(inserts[0]!.params[7]).toBe('3973ea3f-msg')
  })

  it('sem correlationId na origem, a base do suffixo é o messageId da origem', async () => {
    const fake = fakePool([{ insertId: 990, affectedRows: 1 }])
    const orchestrator = new TestGateOrchestrator(fake.pool)

    await orchestrator.enqueue(gateInput, sourceMessage('origem-sem-correlacao'))

    const inserts = outboxInserts(fake.queries)
    expect(inserts).toHaveLength(1)
    expect(String(inserts[0]!.params[6])).toBe('origem-sem-correlacao:gate:990')
  })

  it('reentrega da mesma mensagem de origem não publica segunda vez (INSERT IGNORE sem efeito)', async () => {
    const fake = fakePool([
      { insertId: 991, affectedRows: 1 },
      { insertId: 0, affectedRows: 0, existingId: 991 },
    ])
    const orchestrator = new TestGateOrchestrator(fake.pool)

    const first = await orchestrator.enqueue(gateInput, sourceMessage('msg-redelivered', 'corr-1'))
    const second = await orchestrator.enqueue(gateInput, sourceMessage('msg-redelivered', 'corr-1'))

    expect(first).toBe(991)
    expect(second).toBe(991)
    expect(outboxInserts(fake.queries)).toHaveLength(1)
  })

  it('correlation_id derivado respeita o limite da coluna (varchar 200)', async () => {
    const fake = fakePool([{ insertId: 992, affectedRows: 1 }])
    const orchestrator = new TestGateOrchestrator(fake.pool)
    const longCorrelation = 'x'.repeat(250)

    await orchestrator.enqueue(gateInput, sourceMessage('msg-longa', longCorrelation))

    const inserts = outboxInserts(fake.queries)
    expect(String(inserts[0]!.params[6]).length).toBeLessThanOrEqual(200)
  })
})
