import { describe, expect, it, vi } from 'vitest'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { DlqReconciler, type DlqAlertSender, type DlqTarget, type DlqTransport } from '../src/queue/index.js'
import type { QueueMessage } from '../src/queue/index.js'
import type { DeadLetterVerdict, DeadLetterVisit } from '../src/queue/RabbitMqTransport.js'

function msg(over: Partial<QueueMessage> = {}): QueueMessage {
  return {
    messageId: 'm-1', type: 'TASK_BLOCKED', taskId: 'task-p2-1048', executionId: 'e-1',
    payload: { blockId: 3457 }, timestamp: new Date().toISOString(), attempt: 3, ...over,
  }
}

interface FakeRoute { sql: string; rows: unknown[] }

function fakePool(routes: FakeRoute[]) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql: String(sql), params })
      for (const route of routes) {
        if (String(sql).includes(route.sql)) return [route.rows as RowDataPacket[], []]
      }
      return [[] as RowDataPacket[], []]
    }),
  } as unknown as Pool
  return { pool, queries }
}

function fakeTransport(deadLetters: QueueMessage[], opts: { failClassify?: boolean } = {}) {
  const published: Array<{ queue: string; message: QueueMessage }> = []
  const visits: Array<{ message: QueueMessage; deathCount: number }> = []
  const transport: DlqTransport = {
    visitDeadLetters: vi.fn(async (_queue, _max, visitor) => {
      let acked = 0
      let retried = 0
      for (const message of deadLetters) {
        const visit: DeadLetterVisit = { message, deathCount: 3 }
        visits.push(visit)
        let verdict: DeadLetterVerdict
        try {
          verdict = opts.failClassify ? await Promise.reject(new Error('db fora')) : await visitor(visit)
        } catch {
          verdict = 'retry'
        }
        if (verdict === 'ack') acked += 1
        else { retried += 1; break }
      }
      return { acked, retried }
    }),
    publish: vi.fn(async (queue: string, message: QueueMessage) => { published.push({ queue, message }) }),
    queueDepth: vi.fn(async () => 0),
  }
  return { transport, published, visits }
}

function target(transport: DlqTransport, over: Partial<DlqTarget> = {}): DlqTarget {
  return { dlq: 'motor.monitor.dlq', origin: 'motor.monitor', family: 'monitor', transport, ...over }
}

const OPEN_BLOCKER: FakeRoute = { sql: 'FROM bloqueios WHERE id = ?', rows: [{ resolved_at: null, tarefa_id: 1048 }] }
const RESOLVED_BLOCKER: FakeRoute = { sql: 'FROM bloqueios WHERE id = ?', rows: [{ resolved_at: new Date(), tarefa_id: 1048 }] }
const NO_BLOCKER: FakeRoute = { sql: 'FROM bloqueios WHERE id = ?', rows: [] }
const NO_ALERT_STATE: FakeRoute = { sql: 'FROM motor_dlq_alert_state', rows: [] }

describe('DlqReconciler', () => {
  it('re-enfileira TASK_BLOCKED de bloqueio ainda aberto, com contador no payload e arquivo de auditoria', async () => {
    const env = fakePool([OPEN_BLOCKER, { sql: 'INSERT INTO motor_dlq_archive', rows: [] }, NO_ALERT_STATE])
    const ft = fakeTransport([msg()])
    const reconciler = new DlqReconciler({ pool: env.pool, targets: [target(ft.transport)] })

    const summary = await reconciler.reconcile()
    expect(summary.requeued).toBe(1)
    expect(ft.published).toHaveLength(1)
    expect(ft.published[0]?.queue).toBe('motor.monitor')
    expect(ft.published[0]?.message.payload).toMatchObject({ blockId: 3457, dlqRequeueCount: 1, dlqOrigin: 'motor.monitor.dlq' })
    const archiveQuery = env.queries.find(q => q.sql.includes('INSERT INTO motor_dlq_archive'))
    expect(archiveQuery?.params).toContain('requeued')
    expect(archiveQuery?.params).toContain('blocker_open')
  })

  it('arquiva sem re-enfileirar quando o bloqueio já foi resolvido', async () => {
    const env = fakePool([RESOLVED_BLOCKER, { sql: 'INSERT INTO motor_dlq_archive', rows: [] }, NO_ALERT_STATE])
    const ft = fakeTransport([msg()])
    const reconciler = new DlqReconciler({ pool: env.pool, targets: [target(ft.transport)] })

    const summary = await reconciler.reconcile()
    expect(summary.archived).toBe(1)
    expect(summary.requeued).toBe(0)
    expect(ft.published).toHaveLength(0)
    const archiveQuery = env.queries.find(q => q.sql.includes('INSERT INTO motor_dlq_archive'))
    expect(archiveQuery?.params).toContain('blocker_resolved')
  })

  it('arquiva como obsoleta quando o bloqueio não existe mais (tarefa excluída)', async () => {
    const env = fakePool([NO_BLOCKER, { sql: 'INSERT INTO motor_dlq_archive', rows: [] }, NO_ALERT_STATE])
    const ft = fakeTransport([msg()])
    const reconciler = new DlqReconciler({ pool: env.pool, targets: [target(ft.transport)] })

    const summary = await reconciler.reconcile()
    expect(summary.archived).toBe(1)
    expect(ft.published).toHaveLength(0)
    expect(env.queries.find(q => q.sql.includes('INSERT INTO motor_dlq_archive'))?.params).toContain('blocker_absent')
  })

  it('respeita o limite de re-enqueues por mensagem (sem loop infinito)', async () => {
    const env = fakePool([{ sql: 'INSERT INTO motor_dlq_archive', rows: [] }, NO_ALERT_STATE])
    const ft = fakeTransport([msg({ payload: { blockId: 3457, dlqRequeueCount: 2 } })])
    const reconciler = new DlqReconciler({ pool: env.pool, targets: [target(ft.transport)], maxRequeuesPerMessage: 2 })

    const summary = await reconciler.reconcile()
    expect(summary.archived).toBe(1)
    expect(ft.published).toHaveLength(0)
    expect(env.queries.find(q => q.sql.includes('INSERT INTO motor_dlq_archive'))?.params).toContain('max_dlq_requeues')
  })

  it('test-gates: job vivo é recuperável; job finalizado é arquivado', async () => {
    const alive = fakePool([{ sql: 'FROM test_gate_jobs', rows: [{ status: 'processing' }] }, { sql: 'INSERT INTO motor_dlq_archive', rows: [] }, NO_ALERT_STATE])
    const ftAlive = fakeTransport([msg({ type: 'TEST_RUN_REQUESTED', payload: { jobId: 64 } })])
    const rAlive = new DlqReconciler({ pool: alive.pool, targets: [target(ftAlive.transport, { dlq: 'motor.test-gates.dlq', origin: 'motor.test-gates', family: 'test-gates' })] })
    expect((await rAlive.reconcile()).requeued).toBe(1)

    const done = fakePool([{ sql: 'FROM test_gate_jobs', rows: [{ status: 'passed' }] }, { sql: 'INSERT INTO motor_dlq_archive', rows: [] }, NO_ALERT_STATE])
    const ftDone = fakeTransport([msg({ type: 'TEST_RUN_REQUESTED', payload: { jobId: 64 } })])
    const rDone = new DlqReconciler({ pool: done.pool, targets: [target(ftDone.transport, { dlq: 'motor.test-gates.dlq', origin: 'motor.test-gates', family: 'test-gates' })] })
    const summary = await rDone.reconcile()
    expect(summary.archived).toBe(1)
    expect(ftDone.published).toHaveLength(0)
  })

  it('commands: tarefa com subtarefa ativa é recuperável; tarefa sem trabalho ativo é arquivada', async () => {
    const active = fakePool([
      { sql: 'FROM tarefas t', rows: [{ id: 1047, external_id: 'task-p2-1047' }] },
      { sql: 'EXISTS(SELECT 1 FROM subtarefas', rows: [{ active_subtasks: 1, open_blocker: 0 }] },
      { sql: 'INSERT INTO motor_dlq_archive', rows: [] },
      NO_ALERT_STATE,
    ])
    const ftActive = fakeTransport([msg({ type: 'SUBTASK_EXECUTION_REQUESTED', taskId: 'task-p2-1047', payload: { databaseTaskId: 1047 } })])
    const rActive = new DlqReconciler({ pool: active.pool, targets: [target(ftActive.transport, { dlq: 'motor.commands.dlq', origin: 'motor.commands', family: 'commands' })] })
    expect((await rActive.reconcile()).requeued).toBe(1)

    const final = fakePool([
      { sql: 'FROM tarefas t', rows: [{ id: 900, external_id: 'task-p2-900' }] },
      { sql: 'EXISTS(SELECT 1 FROM subtarefas', rows: [{ active_subtasks: 0, open_blocker: 0 }] },
      { sql: 'INSERT INTO motor_dlq_archive', rows: [] },
      NO_ALERT_STATE,
    ])
    const ftFinal = fakeTransport([msg({ type: 'SUBTASK_EXECUTION_REQUESTED', taskId: 'task-p2-900', payload: { databaseTaskId: 900 } })])
    const rFinal = new DlqReconciler({ pool: final.pool, targets: [target(ftFinal.transport, { dlq: 'motor.commands.dlq', origin: 'motor.commands', family: 'commands' })] })
    const summary = await rFinal.reconcile()
    expect(summary.archived).toBe(1)
    expect(ftFinal.published).toHaveLength(0)
  })

  it('falha de infraestrutura devolve a mensagem (retry) e interrompe o ciclo sem perder nada', async () => {
    const env = fakePool([])
    const ft = fakeTransport([msg(), msg({ messageId: 'm-2' })], { failClassify: true })
    const reconciler = new DlqReconciler({ pool: env.pool, targets: [target(ft.transport)] })

    const summary = await reconciler.reconcile()
    expect(summary.retried).toBe(1)
    expect(summary.requeued).toBe(0)
    expect(summary.archived).toBe(0)
    expect(ft.published).toHaveLength(0)
  })

  it('alerta quando a profundidade cresce, respeita cooldown e zera o estado quando esvazia', async () => {
    const send = vi.fn(async () => {})
    const sender: DlqAlertSender = { send }
    const grew = fakePool([NO_ALERT_STATE, { sql: 'INSERT INTO motor_dlq_alert_state', rows: [] }])
    const ftGrew = fakeTransport([])
    ;(ftGrew.transport.queueDepth as ReturnType<typeof vi.fn>).mockResolvedValue(5)
    const rGrew = new DlqReconciler({ pool: grew.pool, targets: [target(ftGrew.transport)], alertSender: sender })
    expect((await rGrew.reconcile()).alerted).toBe(true)
    expect(send).toHaveBeenCalledOnce()

    const cooling = fakePool([{ sql: 'FROM motor_dlq_alert_state', rows: [{ last_depth: 5, last_alert_at: new Date() }] }])
    const ftCool = fakeTransport([])
    ;(ftCool.transport.queueDepth as ReturnType<typeof vi.fn>).mockResolvedValue(5)
    const rCool = new DlqReconciler({ pool: cooling.pool, targets: [target(ftCool.transport)], alertSender: sender, alertCooldownMinutes: 60 })
    expect((await rCool.reconcile()).alerted).toBe(false)

    const empty = fakePool([{ sql: 'INSERT INTO motor_dlq_alert_state', rows: [] }])
    const ftEmpty = fakeTransport([])
    const rEmpty = new DlqReconciler({ pool: empty.pool, targets: [target(ftEmpty.transport)], alertSender: sender })
    expect((await rEmpty.reconcile()).alerted).toBe(false)
    expect(empty.queries.some(q => q.sql.includes('INSERT INTO motor_dlq_alert_state'))).toBe(true)
  })
})
