// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { TestGateOrchestrator } from '../src/testing/TestGateOrchestrator.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'
import type { TestGateInput } from '../src/testing/TestGateService.js'

/**
 * Incidente 2026-11-24 (task-p2-1100, subtarefa 1581, bloqueio 3537):
 * o baseline ficou vermelho, o Monitor corrigiu os testes (commit 21a3285c) e o
 * BaselinePreflightRecovery.complete() re-pediu a phase 'baseline' com a MESMA
 * mensagem de origem para validar o commit da correção. A chave de dedupe
 * (messageId:phase:subtaskId) não distinguia o commit validado: o INSERT IGNORE
 * deduplicou para o job ANTERIOR (1349, vermelho, pré-correção) e wait() devolveu
 * o resultado obsoleto → bloqueio falso baseline_preflight_failed mesmo com o
 * gate real verde (job 1350, passou 6s antes).
 *
 * A correção inclui o commitSha (12 primeiros chars) no request_message_id:
 * - mesma origem+fase+commit → mesmo job (idempotência de reentrega preservada);
 * - origem+fase com commit DIFERENTE → job novo (revalidação real).
 */

interface CapturedQuery { sql: string; params: unknown[] }

interface FakeJob { insertId: number; affectedRows: number; existingId?: number }

function fakePool(jobs: FakeJob[]): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = []
  let jobIndex = 0
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
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
  return { pool, queries }
}

function baselineInput(commitSha: string): TestGateInput {
  return {
    projectId: 640, taskDatabaseId: 1100, subtaskId: 1581, phase: 'baseline',
    commitSha, baseCommitSha: commitSha, branchName: 'motor-v3-work/integration-task-p2-1100',
    workspacePath: '/tmp/integration', buildCommand: 'npm run build', testCommand: 'npm test',
  } as TestGateInput
}

function sourceMessage(messageId: string): QueueMessage {
  return createQueueMessage({
    messageId,
    type: 'SUBTASK_EXECUTION_STARTED', taskId: 'task-p2-1100',
    executionId: `exec-${messageId}`, payload: { subtaskId: 1581 },
  })
}

function gateInserts(queries: CapturedQuery[]): CapturedQuery[] {
  return queries.filter(q => q.sql.includes('INSERT IGNORE INTO test_gate_jobs'))
}

function outboxInserts(queries: CapturedQuery[]): CapturedQuery[] {
  return queries.filter(q => q.sql.includes('INSERT INTO motor_outbox'))
}

const PRE_FIX_COMMIT = '2d09c84bce2b0156e6ea07f98c0ad7fe706c43e8'
const POST_FIX_COMMIT = '67337a7c8db46eedb5acad1bc885712fda79112f'

describe('TestGateOrchestrator — dedupe por origem+fase+commit', () => {
  it('revalidação pós-correção (mesma origem, commit novo) cria job novo em vez de reusar o job falho', async () => {
    const fake = fakePool([
      { insertId: 1349, affectedRows: 1 }, // baseline original (vermelho)
      { insertId: 1352, affectedRows: 1 }, // revalidação no commit da correção
    ])
    const orchestrator = new TestGateOrchestrator(fake.pool)
    const source = sourceMessage('5e6ebd40-msg')

    const firstJob = await orchestrator.enqueue(baselineInput(PRE_FIX_COMMIT), source)
    const revalidationJob = await orchestrator.enqueue(baselineInput(POST_FIX_COMMIT), source)

    expect(firstJob).toBe(1349)
    expect(revalidationJob).toBe(1352)

    const keys = gateInserts(fake.queries).map(q => String(q.params[0]))
    expect(keys[0]).toBe(`5e6ebd40-msg:baseline:1581:${PRE_FIX_COMMIT.slice(0, 12)}`)
    expect(keys[1]).toBe(`5e6ebd40-msg:baseline:1581:${POST_FIX_COMMIT.slice(0, 12)}`)
    expect(new Set(keys).size).toBe(2)
    // Cada job novo publica o próprio comando.
    expect(outboxInserts(fake.queries)).toHaveLength(2)
  })

  it('reentrega da mesma mensagem para o MESMO commit continua deduplicando (sem segundo job, sem republicar)', async () => {
    const fake = fakePool([
      { insertId: 1360, affectedRows: 1 },
      { insertId: 0, affectedRows: 0, existingId: 1360 },
    ])
    const orchestrator = new TestGateOrchestrator(fake.pool)

    const first = await orchestrator.enqueue(baselineInput(PRE_FIX_COMMIT), sourceMessage('msg-redelivered'))
    const second = await orchestrator.enqueue(baselineInput(PRE_FIX_COMMIT), sourceMessage('msg-redelivered'))

    expect(first).toBe(1360)
    expect(second).toBe(1360)
    expect(outboxInserts(fake.queries)).toHaveLength(1)
  })

  it('request_message_id permanece dentro do limite da coluna (varchar 100)', async () => {
    const fake = fakePool([{ insertId: 1361, affectedRows: 1 }])
    const orchestrator = new TestGateOrchestrator(fake.pool)
    const longMessageId = 'm'.repeat(120)

    await orchestrator.enqueue(baselineInput(POST_FIX_COMMIT), sourceMessage(longMessageId))

    const key = String(gateInserts(fake.queries)[0]!.params[0])
    expect(key.length).toBeLessThanOrEqual(100)
  })

  it('input sem commitSha mantém a chave legacy (origem+fase+subtarefa)', async () => {
    const fake = fakePool([{ insertId: 1362, affectedRows: 1 }])
    const orchestrator = new TestGateOrchestrator(fake.pool)
    const input = { ...baselineInput(''), commitSha: '' } as TestGateInput

    await orchestrator.enqueue(input, sourceMessage('msg-sem-sha'))

    expect(String(gateInserts(fake.queries)[0]!.params[0])).toBe('msg-sem-sha:baseline:1581')
  })
})
