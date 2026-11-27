// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  MySqlDevelopmentExecutionRepository,
  subtaskExecutionCorrelation,
} from '../src/execution/DevelopmentExecutionRepository.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

/**
 * Regressão do incidente da tarefa 1070 (27/11/2026) — motor travado com
 * subtarefas pendentes na fila:
 *
 * 1. A raiz de correlação `3fd7b6c9…` era da tarefa 1070 (SER da subtarefa
 *    1624 já publicado, chave `<raiz>:sub:1624`).
 * 2. Ao falhar, a 1070 liberou a vaga e `wakeCapacityWaiters` acordou a 1135
 *    HERDANDO a raiz da 1070 → a 1135 rodou a sub 1627 sob `<raiz>:sub:1627`.
 * 3. A 1135 falhou, liberou a vaga e acordou a 1070 com
 *    `correlationId = <raiz>:sub:1627` (vazada de volta).
 * 4. O consumidor da 1070 reservou a sub 1624 → `subtaskExecutionCorrelation`
 *    recompôs `<raiz>:sub:1624` — idêntica ao SER original da própria 1070 →
 *    ER_DUP_ENTRY em `motor_outbox_logical_key_unique` → rollback → a wake
 *    falhou em todas as redeliveries → tarefa órfã na fila para sempre.
 *
 * A correção: wake de capacidade é retomada INDEPENDENTE da tarefa acordada —
 * emite correlação própria (o messageId da mensagem de wake) e mantém a
 * rastreabilidade via causationId. Nenhuma raiz vaza entre tarefas.
 */

describe('wakeCapacityWaiters — raiz de correlação própria por wake (incidente 1070)', () => {
  const makeWakeHarness = (source: QueueMessage) => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const connection = {
      query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
        const normalizedSql = sql.replace(/\s+/g, ' ').trim()
        queries.push({ sql: normalizedSql, params: params ?? [] })
        if (normalizedSql.includes('FROM motor_execution_wait_queue q') && normalizedSql.includes('LIMIT 25')) {
          return [[{ tarefa_id: 1070, task_id: 'macro-gestao-de-tarefas-global-9' }]]
        }
        if (normalizedSql.includes('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }]
        if (normalizedSql.includes('UPDATE motor_execution_wait_queue')) return [{ affectedRows: 1 }]
        return [{}]
      }),
    } as any
    const repo = new MySqlDevelopmentExecutionRepository({} as any)
    return { repo, connection, queries, source }
  }

  it('não herda a correlação da tarefa-fonte: wake sai com correlação própria e causationId rastreável', async () => {
    const leakedSource: QueueMessage = {
      messageId: 'task-completed-1135', type: 'TASK_EXECUTION_COMPLETED',
      taskId: 'setup-vitrine-ia-loja-de-atendentes-virtuais', executionId: 'exec-1135',
      correlationId: '3fd7b6c9-b84f-480a-a5a1-1b0b346cae7f:sub:1627',
      payload: {}, timestamp: new Date().toISOString(), attempt: 1,
    }
    const { repo, connection, queries } = makeWakeHarness(leakedSource)

    await (repo as any).wakeCapacityWaiters(connection, leakedSource)

    const wakeInserts = queries.filter(
      q => q.sql.includes('INSERT INTO motor_outbox') && String(q.params[1]) === 'TASK_READY_FOR_PROGRAMMING',
    )
    expect(wakeInserts).toHaveLength(1)
    const wakeMessage = wakeInserts[0]
    expect(wakeMessage.params[2]).toBe('macro-gestao-de-tarefas-global-9')
    // Correlação da tarefa-fonte (raiz vazada) NÃO pode ser herdada.
    expect(wakeMessage.params[6]).toBeNull()
    // Rastreabilidade da liberação preservada.
    expect(wakeMessage.params[7]).toBe(leakedSource.messageId)
  })

  it('a SER derivada da wake não colide com a primeira tentativa da subtarefa (ER_DUP_ENTRY)', async () => {
    const leakedSource: QueueMessage = {
      messageId: 'task-completed-1135', type: 'TASK_EXECUTION_COMPLETED',
      taskId: 'setup-vitrine-ia-loja-de-atendentes-virtuais', executionId: 'exec-1135',
      correlationId: '3fd7b6c9-b84f-480a-a5a1-1b0b346cae7f:sub:1627',
      payload: {}, timestamp: new Date().toISOString(), attempt: 1,
    }
    const originalRoot = '3fd7b6c9-b84f-480a-a5a1-1b0b346cae7f'
    const { repo, connection, queries } = makeWakeHarness(leakedSource)

    await (repo as any).wakeCapacityWaiters(connection, leakedSource)
    const wakeInsert = queries.find(
      q => q.sql.includes('INSERT INTO motor_outbox') && String(q.params[1]) === 'TASK_READY_FOR_PROGRAMMING',
    )!
    const wakeMessageId = String(wakeInsert.params[0])

    // O consumidor da 1070 processa a wake sem correlação → raiz cai no
    // messageId da wake → chave única, diferente do SER original (linha
    // 603096, `<raiz-original>:sub:1624`, que causava o dup).
    const derived = subtaskExecutionCorrelation(
      { correlationId: (wakeInsert.params[6] as string | null) ?? null, messageId: wakeMessageId },
      1624,
    )
    expect(derived).toBe(`${wakeMessageId}:sub:1624`)
    expect(derived).not.toBe(`${originalRoot}:sub:1624`)
  })

  it('duas wakes para a mesma tarefa nunca compartilham a mesma chave lógica', async () => {
    const sourceA: QueueMessage = {
      messageId: 'msg-a', type: 'SUBTASK_EXECUTION_FAILED', taskId: 'task-x', executionId: 'e-a',
      correlationId: 'root-a:sub:1', payload: {}, timestamp: new Date().toISOString(), attempt: 1,
    }
    const sourceB: QueueMessage = {
      messageId: 'msg-b', type: 'SUBTASK_EXECUTION_FAILED', taskId: 'task-y', executionId: 'e-b',
      correlationId: 'root-a:sub:2', payload: {}, timestamp: new Date().toISOString(), attempt: 1,
    }
    const first = makeWakeHarness(sourceA)
    const second = makeWakeHarness(sourceB)
    await (first.repo as any).wakeCapacityWaiters(first.connection, sourceA)
    await (second.repo as any).wakeCapacityWaiters(second.connection, sourceB)

    const wakeOf = (h: ReturnType<typeof makeWakeHarness>) => h.queries.find(
      q => q.sql.includes('INSERT INTO motor_outbox') && String(q.params[1]) === 'TASK_READY_FOR_PROGRAMMING',
    )!
    const keyOf = (w: { params: unknown[] }) =>
      subtaskExecutionCorrelation(
        { correlationId: (w.params[6] as string | null) ?? null, messageId: String(w.params[0]) }, 1624,
      )
    expect(keyOf(wakeOf(first))).not.toBe(keyOf(wakeOf(second)))
  })
})
