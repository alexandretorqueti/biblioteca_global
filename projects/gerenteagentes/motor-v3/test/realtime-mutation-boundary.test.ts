import { describe, expect, it, vi } from 'vitest'
import { RealtimeMutationBoundary } from '../src/realtime/RealtimeMutationBoundary.js'
import { RealtimeOutboxDispatcher } from '../src/realtime/RealtimeOutboxDispatcher.js'

function transactionStub() {
  let analysisStarted = false
  let nextSeq = 1
    const connection = {
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, external_id, projeto_id FROM tarefas')) return [[{ id: 10, external_id: 'task-10', projeto_id: 7 }]]
      if (sql.includes('f.analysis_started_at')) return [[{
        id: 10, paused_at: null, resource_wait_key: null, analysis_started_at: analysisStarted ? new Date() : null,
        clarification_pending_at: null, integration_confirmed_at: null, terminal_status: null,
        awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0,
        administrative_deploy_cancelled: 0,
      }]]
      if (sql.includes('SELECT status, completion_kind')) return [[]]
      if (sql.includes('UPDATE task_runtime_facts')) { analysisStarted = true; return [{ affectedRows: 1 }] }
      if (sql.includes('MAX(per_task_seq)')) return [[{ next_seq: nextSeq++ }]]
      if (sql.includes('COUNT(*) AS total')) return [[{ total: 0, pending: 0, running: 0, completed: 0, failed: 0 }]]
      return [{ affectedRows: 1, insertId: 1 }]
    }),
  }
  return { connection, pool: { getConnection: vi.fn(async () => connection) } }
}

describe('RealtimeMutationBoundary', () => {
  it('enfileira chat no tenant com payload durável e managedProjectId', async () => {
    const stub = transactionStub()
    const boundary = new RealtimeMutationBoundary(stub.pool as never)
    const event = await boundary.appendChatMessage(stub.connection as never, 10, {
      id: 44, role: 'analyst', texto: '{"questions":["Q1"]}', createdAt: '2026-10-13T14:00:00.000Z',
    })

    expect(event).toMatchObject({
      taskId: 10, projectId: 640, type: 'task.chat.message.created', perTaskSeq: 1,
      payload: {
        id: 44, role: 'analyst', texto: '{"questions":["Q1"]}',
        createdAt: '2026-10-13T14:00:00.000Z', managedProjectId: 7,
      },
    })
    expect(event?.eventId).toEqual(expect.any(String))
  })

  it('calcula previousStatus/status e grava o evento dentro do mesmo commit', async () => {
    const stub = transactionStub()
    const boundary = new RealtimeMutationBoundary(stub.pool as never)
    const events = await boundary.executar(10, {
      apply: async ({ connection }) => {
        await connection.query('UPDATE task_runtime_facts SET analysis_started_at = NOW() WHERE tarefa_id = ?', [10])
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'task.status.changed', previousStatus: 'planned', status: 'analyzing', perTaskSeq: 1 })
    expect(events[0]?.eventId).toEqual(expect.any(String))
    expect(events[1]).toMatchObject({ type: 'task.counters.updated', perTaskSeq: 2 })
    expect(stub.connection.beginTransaction).toHaveBeenCalledOnce()
    expect(stub.connection.commit).toHaveBeenCalledOnce()
    expect(stub.connection.rollback).not.toHaveBeenCalled()
  })

  it('faz rollback do fato e não deixa evento durável quando a mutação falha', async () => {
    const stub = transactionStub()
    const boundary = new RealtimeMutationBoundary(stub.pool as never)
    await expect(boundary.executar(10, { apply: async () => { throw new Error('falha canônica') } })).rejects.toThrow('falha canônica')
    expect(stub.connection.rollback).toHaveBeenCalledOnce()
    expect(stub.connection.commit).not.toHaveBeenCalled()
  })

  it('projeta closed no evento realtime quando o fato terminal completed é gravado sem subtarefas (tarefa 1029)', async () => {
    // A fronteira realtime usa o MESMO resolvedor canônico do polling: o fato
    // terminal_status='completed' sem subtarefas deve projetar `closed` aqui
    // também, inclusive com tipo='desenvolvimento'.
    let terminal = false
    let nextSeq = 1
    const connection = {
      beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id, external_id, projeto_id FROM tarefas')) return [[{ id: 1029, external_id: 'task-p2-1029', projeto_id: 7 }]]
        if (sql.includes('f.analysis_started_at')) return [[{
          id: 1029, task_type: 'desenvolvimento', paused_at: null, resource_wait_key: null,
          analysis_started_at: null, clarification_pending_at: null, integration_confirmed_at: null,
          terminal_status: terminal ? 'completed' : null,
          awaiting_interaction: 0, has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0,
          administrative_deploy_cancelled: 0, active_monitor_fix: 0,
        }]]
        if (sql.includes('SELECT status, completion_kind')) return [[]]
        if (sql.includes('UPDATE task_runtime_facts')) { terminal = true; return [{ affectedRows: 1 }] }
        if (sql.includes('MAX(per_task_seq)')) return [[{ next_seq: nextSeq++ }]]
        if (sql.includes('COUNT(*) AS total')) return [[{ total: 0, pending: 0, running: 0, completed: 0, failed: 0 }]]
        return [{ affectedRows: 1, insertId: 1 }]
      }),
    }
    const pool = { getConnection: vi.fn(async () => connection) }
    const boundary = new RealtimeMutationBoundary(pool as never)

    const events = await boundary.executar(1029, {
      apply: async ({ connection: tx }) => {
        await tx.query("UPDATE task_runtime_facts SET terminal_status = 'completed' WHERE tarefa_id = ?", [1029])
      },
    })

    const statusChanged = events.find(event => event.type === 'task.status.changed')
    expect(statusChanged).toMatchObject({ previousStatus: 'planned', status: 'closed' })
    expect(connection.commit).toHaveBeenCalledOnce()
  })
})

describe('RealtimeOutboxDispatcher', () => {
  it('reenvia o mesmo eventId após falha e preserva a ordem', async () => {
    const rows = [{ event_id: 'evt-1', task_id: 10, source_task_id: 'task-10', project_id: 7,
      subtask_id: null, type: 'task.status.changed', previous_status: 'draft', status: 'planned',
      payload: JSON.stringify({ previousStatus: 'draft', status: 'planned' }), per_task_seq: 1,
      attempts: 0, created_at: new Date() }]
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM realtime_event_outbox o')) return [rows]
      return [{ affectedRows: 1 }]
    })
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('ingresso indisponível'))
      .mockResolvedValueOnce(undefined)
    const dispatcher = new RealtimeOutboxDispatcher({ query } as never, { publish })

    await dispatcher.flush()
    await dispatcher.flush()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls[0]?.[0].eventId).toBe('evt-1')
    expect(publish.mock.calls[1]?.[0].eventId).toBe('evt-1')
    expect(query.mock.calls.filter(call => call[0].includes("delivery_status = 'failed'")).length).toBe(1)
  })
})
