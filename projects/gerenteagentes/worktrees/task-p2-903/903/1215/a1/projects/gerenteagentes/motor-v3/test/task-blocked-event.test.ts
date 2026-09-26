import { describe, expect, it, vi } from 'vitest'
import { DeployRepository } from '../src/deploy/DeployRepository.js'
import { createTaskBlockedMessage, TASK_BLOCKED_EVENT_TYPE } from '../src/monitor/index.js'
import { createQueueMessage } from '../src/queue/index.js'

function fakeTxPool(responses: Array<[unknown, unknown]> = []) {
  const queries: { sql: string; params: unknown[] }[] = []
  const record = async (sql: string, params?: unknown[]): Promise<[unknown, unknown]> => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params ?? [] })
    return responses.shift() ?? [{ affectedRows: 1 }, []]
  }
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(record),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = { getConnection: vi.fn(async () => connection), query: vi.fn(record) } as any
  return { pool, connection, queries }
}

function outboxEvents(queries: { sql: string; params: unknown[] }[], type: string) {
  return queries.filter(q => q.sql.includes('INSERT INTO motor_outbox') && q.params[1] === type)
}

describe('createTaskBlockedMessage (contrato do evento)', () => {
  it('produz mensagem serializável com tipo TASK_BLOCKED e payload completo', () => {
    const message = createTaskBlockedMessage({
      taskId: 'task-p1-886',
      executionId: 'exec-1',
      payload: { blockReason: 'deploy_failed', batchId: 'b-1', databaseTaskId: 886 },
    })

    expect(message.type).toBe(TASK_BLOCKED_EVENT_TYPE)
    expect(message.taskId).toBe('task-p1-886')
    expect(message.executionId).toBe('exec-1')
    expect(message.messageId).toBeTruthy()
    expect(message.payload).toMatchObject({ blockReason: 'deploy_failed', batchId: 'b-1', databaseTaskId: 886 })
    // Serializável (fronteira da fila durável)
    expect(JSON.parse(JSON.stringify(message))).toMatchObject({ type: 'TASK_BLOCKED' })
  })
})

describe('DeployRepository.blockTask emite TASK_BLOCKED', () => {
  it('grava bloqueio e evento na mesma transação, com correlação da mensagem de origem', async () => {
    const { pool, connection, queries } = fakeTxPool()
    const repository = new DeployRepository(pool, '/tmp/worktrees')
    const source = createQueueMessage({ type: 'DEPLOY_REQUESTED', taskId: 'task-p1-886', executionId: 'exec-886', payload: {} })

    await repository.blockTask('task-p1-886', 'deploy_preparation_failed', 'detalhe da falha', source)

    const insertBlock = queries.find(q => q.sql.includes('INSERT INTO bloqueios'))
    expect(insertBlock).toBeDefined()
    expect(insertBlock!.params[0]).toBe('deploy_preparation_failed')

    const events = outboxEvents(queries, 'TASK_BLOCKED')
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0].params[5] as string)
    expect(payload).toMatchObject({
      blockReason: 'deploy_preparation_failed',
      blockCommand: 'motor-v3:deploy',
      blockExcerpt: 'detalhe da falha',
    })
    expect(events[0].params[3]).toBe('task-p1-886')
    // correlação/causação herdadas da mensagem de origem
    expect(events[0].params[6]).toBe(source.correlationId ?? source.messageId)
    expect(events[0].params[7]).toBe(source.messageId)
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('funciona sem mensagem de origem (executionId derivado)', async () => {
    const { pool, queries } = fakeTxPool()
    const repository = new DeployRepository(pool, '/tmp/worktrees')

    await repository.blockTask('task-p1-886', 'pre_deploy_gate_failed', 'Gate pre_deploy falhou')

    const events = outboxEvents(queries, 'TASK_BLOCKED')
    expect(events).toHaveLength(1)
    expect(String(events[0].params[4])).toMatch(/^block-task-p1-886-\d+$/)
    expect(JSON.parse(events[0].params[5] as string)).toMatchObject({ blockReason: 'pre_deploy_gate_failed' })
  })

  it('faz rollback quando a transação falha', async () => {
    const { pool, connection } = fakeTxPool()
    ;(connection.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'))
    const repository = new DeployRepository(pool, '/tmp/worktrees')

    await expect(repository.blockTask('task-p1-886', 'x', 'y')).rejects.toThrow('db down')
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })
})

describe('DeployRepository.completeBatch emite TASK_BLOCKED por tarefa quando o lote falha', () => {
  const source = createQueueMessage({ type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', taskId: 'task-p1-886', executionId: 'exec-batch', payload: {} })

  it('emite TASK_DEPLOY_BLOCKED e TASK_BLOCKED com batchId e databaseTaskId', async () => {
    const { pool, connection, queries } = fakeTxPool([
      [{ affectedRows: 1 }, []], // UPDATE deploy_batches
      [[{ external_id: 'task-p1-886', task_id: 886 }], []], // SELECT requests
      [{ affectedRows: 1 }, []], // UPDATE deploy_requests
      [{ affectedRows: 1 }, []], // INSERT bloqueios
      [{ affectedRows: 1 }, []], // outbox DEPLOY_BATCH_FAILED
      [{ affectedRows: 1 }, []], // outbox TASK_DEPLOY_BLOCKED
      [{ affectedRows: 1 }, []], // outbox TASK_BLOCKED
      [[], []], // insertPendingDispatches SELECT
    ])
    const repository = new DeployRepository(pool, '/tmp/worktrees')

    const blockedTasks = await repository.completeBatch('batch-1', false, 'script blue-green informou falha', source)

    expect(blockedTasks).toEqual(['task-p1-886'])
    const events = outboxEvents(queries, 'TASK_BLOCKED')
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0].params[5] as string)
    expect(payload).toMatchObject({
      blockReason: 'deploy_failed',
      blockCommand: 'motor-v3:deploy:batch-1',
      blockExcerpt: 'script blue-green informou falha',
      batchId: 'batch-1',
      databaseTaskId: 886,
    })
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('não emite TASK_BLOCKED quando o lote tem sucesso', async () => {
    const { pool, queries } = fakeTxPool([
      [{ affectedRows: 1 }, []], // UPDATE deploy_batches
      [[{ external_id: 'task-p1-886', task_id: 886 }], []], // SELECT requests
      [{ affectedRows: 1 }, []], // UPDATE deploy_requests
      [{ affectedRows: 1 }, []], // outbox DEPLOY_BATCH_SUCCEEDED
      [{ affectedRows: 1 }, []], // outbox TASK_DEPLOYED
      [[], []], // SELECT tarefas dependentes elegíveis
      [[], []], // insertPendingDispatches SELECT
    ])
    const repository = new DeployRepository(pool, '/tmp/worktrees')

    const deployed = await repository.completeBatch('batch-2', true, null, source)

    expect(deployed).toEqual(['task-p1-886'])
    expect(outboxEvents(queries, 'TASK_BLOCKED')).toHaveLength(0)
    expect(queries.some(q => q.sql.includes('INSERT INTO bloqueios'))).toBe(false)
  })
})
