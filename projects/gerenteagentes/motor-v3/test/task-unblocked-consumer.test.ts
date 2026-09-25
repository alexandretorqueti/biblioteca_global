import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { TaskUnblockedConsumer, createTaskUnblockedMessage, TASK_UNBLOCKED_EVENT_TYPE } from '../src/monitor/index.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'

interface FakeOptions {
  taskIdResolvable?: boolean
  pendingGroups?: Array<{ repo_path: string; base_branch: string; requested_commit: string }>
}

function fakeEnvironment(options: FakeOptions = {}) {
  const queries: { sql: string; params: unknown[]; via: 'pool' | 'connection' }[] = []
  const record = (via: 'pool' | 'connection') => async (sql: string, params?: unknown[]) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params: params ?? [], via })
    if (normalized.includes('FROM tarefas')) {
      return [options.taskIdResolvable === false ? [] : [{ id: 886 }], []]
    }
    if (normalized.includes('FROM deploy_requests')) {
      const groups = options.pendingGroups ?? [
        { repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc123' },
      ]
      return [groups, []]
    }
    return [{ affectedRows: 1 }, []]
  }
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(record('connection')),
  }
  const pool = {
    query: vi.fn(record('pool')),
    getConnection: vi.fn(async () => connection),
  } as unknown as Pool
  const events: Array<{ taskId: string; evento: string; payload: unknown }> = []
  const eventsSink = { record: vi.fn(async (taskId: string, evento: string, _ator?: string, payload?: unknown) => { events.push({ taskId, evento, payload }) }) }
  const consumer = new TaskUnblockedConsumer(pool, eventsSink)
  const outbox = (type: string) => queries.filter(q => q.sql.includes('INSERT INTO motor_outbox') && q.params[1] === type)
  return { consumer, pool, connection, queries, outbox, events }
}

function unblockedMessage(payload: Record<string, unknown>, overrides: Partial<QueueMessage> = {}): QueueMessage {
  return createTaskUnblockedMessage({
    taskId: 'task-p1-886',
    executionId: 'unblock-45-1',
    payload: { blockId: 45, blockReason: 'deploy_failed', databaseTaskId: 886, resolvedBy: 'monitor', ...payload },
    ...overrides,
  })
}

describe('TaskUnblockedConsumer', () => {
  it('ignora mensagens que não são TASK_UNBLOCKED', async () => {
    const env = fakeEnvironment()
    await env.consumer.handle(createQueueMessage({ type: TASK_UNBLOCKED_EVENT_TYPE.replace('UN', ''), taskId: 't', executionId: 'e', payload: {} }))
    expect(env.pool.query).not.toHaveBeenCalled()
  })

  it('deploy_failed: reativa pedidos failed e enfileira dispatch na mesma transação', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(unblockedMessage({}))

    const reset = env.queries.find(q => q.sql.includes("UPDATE deploy_requests SET status='pending'"))
    expect(reset).toBeDefined()
    expect(reset!.via).toBe('connection')
    expect(reset!.params).toEqual([886])

    const dispatches = env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].via).toBe('connection')
    expect(dispatches[0].params[3]).toBe('886')
    const payload = JSON.parse(dispatches[0].params[5] as string)
    expect(payload).toMatchObject({
      repository: '/repo/biblioteca-global',
      baseBranch: 'base-desenvolvimento',
      expectedCommit: 'abc123',
    })
    expect(env.connection.commit).toHaveBeenCalledOnce()

    const resumed = env.events.find(e => e.evento === 'task_resumed_by_monitor')
    expect(resumed!.payload).toMatchObject({ blockReason: 'deploy_failed', action: 'deploy_requeued', dispatched: 1 })
  })

  it('pre_deploy_gate_failed e deploy_preparation_failed também retomam o deploy', async () => {
    for (const reason of ['pre_deploy_gate_failed', 'deploy_preparation_failed']) {
      const env = fakeEnvironment()
      await env.consumer.handle(unblockedMessage({ blockReason: reason }))
      expect(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')).toHaveLength(1)
    }
  })

  it('sem pedidos pending após reset: não enfileira dispatch mas registra retomada', async () => {
    const env = fakeEnvironment({ pendingGroups: [] })

    await env.consumer.handle(unblockedMessage({}))

    expect(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')).toHaveLength(0)
    const resumed = env.events.find(e => e.evento === 'task_resumed_by_monitor')
    expect(resumed!.payload).toMatchObject({ action: 'deploy_requeued', dispatched: 0 })
  })

  it('analysis_failed: enfileira TASK_RESUME_REQUESTED para o coordenador', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(unblockedMessage({ blockReason: 'analysis_failed' }))

    const resumes = env.outbox('TASK_RESUME_REQUESTED')
    expect(resumes).toHaveLength(1)
    expect(resumes[0].params[3]).toBe('task-p1-886')
    expect(JSON.parse(resumes[0].params[5] as string)).toMatchObject({ resumedBy: 'monitor' })
    expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload)
      .toMatchObject({ action: 'analysis_resume_enqueued' })
  })

  it('outros motivos: apenas auditoria (noop)', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(unblockedMessage({ blockReason: 'outro_motivo' }))

    expect(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')).toHaveLength(0)
    expect(env.outbox('TASK_RESUME_REQUESTED')).toHaveLength(0)
    expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload).toMatchObject({ action: 'noop' })
  })

  it('resolve databaseTaskId pelo external_id quando ausente no payload', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(unblockedMessage({ databaseTaskId: undefined }))

    const select = env.queries.find(q => q.sql.includes('SELECT id FROM tarefas'))
    expect(select).toBeDefined()
    expect(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')).toHaveLength(1)
  })

  it('tarefa não encontrada: registra skipped sem quebrar', async () => {
    const env = fakeEnvironment({ taskIdResolvable: false })

    await env.consumer.handle(unblockedMessage({ databaseTaskId: undefined }))

    expect(env.events[0].evento).toBe('task_resume_skipped')
    expect(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')).toHaveLength(0)
  })

  it('falha na transação não propaga para a fila e registra task_resume_failed', async () => {
    const env = fakeEnvironment()
    ;(env.connection.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db instável'))

    await expect(env.consumer.handle(unblockedMessage({}))).resolves.toBeUndefined()

    expect(env.connection.rollback).toHaveBeenCalledOnce()
    expect(env.events.find(e => e.evento === 'task_resume_failed')!.payload).toMatchObject({ error: 'db instável' })
  })
})
