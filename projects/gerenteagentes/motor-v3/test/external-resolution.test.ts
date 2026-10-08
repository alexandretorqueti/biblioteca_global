// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ExternalResolutionError, ExternalResolutionHandler } from '../src/monitor/ExternalResolutionHandler.js'

interface FakeOptions {
  task?: { id: number; external_id: string | null; tipo: string } | null
  blockersResolved?: number
  subtaskUpdateAffected?: number
  subtaskExists?: boolean
  counts?: { total: number; finais: number | null }
  terminalStatus?: string | null
  factsRowExists?: boolean
}

function fakePool(options: FakeOptions = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params })
      if (/SELECT t\.id, t\.external_id, t\.tipo/.test(sql)) {
        const task = options.task === undefined
          ? { id: 820, external_id: 'task-p2-820', tipo: 'desenvolvimento' }
          : options.task
        return [task ? [task] : []]
      }
      if (/UPDATE bloqueios/.test(sql)) return [{ affectedRows: options.blockersResolved ?? 0 }]
      if (/UPDATE subtarefas/.test(sql)) return [{ affectedRows: options.subtaskUpdateAffected ?? 1 }]
      if (/SELECT id FROM subtarefas WHERE id = \? AND tarefa_id/.test(sql)) {
        return [options.subtaskExists === false ? [] : [{ id: 1 }]]
      }
      if (/SUM\(status IN \('verified', 'superseded'\)\)/.test(sql)) {
        const counts = options.counts ?? { total: 5, finais: 5 }
        return [[{ total: counts.total, finais: counts.finais }]]
      }
      if (/SELECT terminal_status FROM task_runtime_facts/.test(sql)) {
        if (options.factsRowExists === false) return [[]]
        return [[{ terminal_status: options.terminalStatus ?? null }]]
      }
      return [{ affectedRows: 1 }]
    }),
  }
  const pool = { getConnection: vi.fn(async () => connection) }
  const outboxMessages = () => calls
    .filter(call => /INSERT INTO motor_outbox/.test(call.sql))
    .map(call => ({ type: String(call.params[1]), taskId: String(call.params[3]), payload: JSON.parse(String(call.params[5])) }))
  return { pool, connection, calls, outboxMessages }
}

describe('ExternalResolutionHandler (camada C — resolução externa governada)', () => {
  it('reconcilia a conclusão quando todas as subtarefas já estão finais (caso 820)', async () => {
    const fake = fakePool({ blockersResolved: 0, counts: { total: 5, finais: 5 }, terminalStatus: null })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-820',
      motivo: 'Merge conflict + mocks corrigidos e deployados manualmente (commit 43aa19c)',
      resolvedBy: 'external_monitor_resolution',
    })

    expect(result.ok).toBe(true)
    expect(result.completed).toBe(true)
    expect(result.deployRequested).toBe(false)
    expect(result.requeued).toBe(false)
    // Fatos de conclusão gravados na transação
    expect(fake.calls.some(call => /INSERT INTO task_runtime_facts/.test(call.sql))).toBe(true)
    // Outbox: TASK_EXECUTION_COMPLETED emitido, sem DEPLOY_REQUESTED (requestDeploy ausente)
    const types = fake.outboxMessages().map(message => message.type)
    expect(types).toContain('TASK_EXECUTION_COMPLETED')
    expect(types).not.toContain('DEPLOY_REQUESTED')
    // Zumbi da fila de capacidade removido
    expect(fake.calls.some(call => /DELETE FROM motor_execution_wait_queue/.test(call.sql))).toBe(true)
    // Auditoria na trilha da tarefa
    expect(fake.calls.some(call => /INSERT INTO tarefa_eventos/.test(call.sql) && /external_resolution/.test(call.sql))).toBe(true)
    expect(fake.connection.commit).toHaveBeenCalled()
    // Supressão do trigger (camada A) definida e liberada na conexão
    expect(fake.calls.some(call => /SET @motor_completing := 1/.test(call.sql))).toBe(true)
    expect(fake.calls.some(call => /SET @motor_completing := NULL/.test(call.sql))).toBe(true)
  })

  it('emite DEPLOY_REQUESTED quando requestDeploy=true e a tarefa é de desenvolvimento', async () => {
    const fake = fakePool({ counts: { total: 2, finais: 2 } })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-820', motivo: 'conclusão', resolvedBy: 'teste', requestDeploy: true,
    })

    expect(result.deployRequested).toBe(true)
    const types = fake.outboxMessages().map(message => message.type)
    expect(types).toContain('DEPLOY_REQUESTED')
    expect(types).toContain('TASK_EXECUTION_COMPLETED')
  })

  it('dispensa deploys antigos sem requestDeploy e preserva o fluxo explícito quando solicitado', async () => {
    const withoutDeploy = fakePool({ counts: { total: 1, finais: 1 } })
    await new ExternalResolutionHandler(withoutDeploy.pool as never).handle({
      taskId: 'task-p2-820', motivo: 'já deployada externamente', resolvedBy: 'monitor',
    })
    const cancelled = withoutDeploy.calls.find(call => /UPDATE deploy_requests dr/.test(call.sql))
    expect(cancelled?.sql).toContain("dr.status='cancelled'")
    expect(cancelled?.params[0]).toContain('blocker=external_resolution')
    expect(cancelled?.params[0]).toContain('resolvedBy=monitor')
    expect(withoutDeploy.calls.some(call => /SELECT COUNT\(\*\) AS total[\s\S]*deploy_requests/.test(call.sql))).toBe(true)

    const withDeploy = fakePool({ counts: { total: 1, finais: 1 } })
    await new ExternalResolutionHandler(withDeploy.pool as never).handle({
      taskId: 'task-p2-820', motivo: 'deploy explícito', resolvedBy: 'monitor', requestDeploy: true,
    })
    expect(withDeploy.calls.some(call => /UPDATE deploy_requests dr/.test(call.sql))).toBe(false)
  })

  it('devolve a tarefa ao fluxo normal quando ainda há subtarefas pendentes', async () => {
    const fake = fakePool({ blockersResolved: 2, counts: { total: 5, finais: 2 } })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-829', motivo: 'bloqueio sistêmico resolvido', resolvedBy: 'teste',
    })

    expect(result.completed).toBe(false)
    expect(result.requeued).toBe(true)
    expect(result.blockersResolved).toBe(2)
    const types = fake.outboxMessages().map(message => message.type)
    expect(types).toContain('TASK_READY_FOR_PROGRAMMING')
    expect(types).toContain('TASK_UNBLOCKED')
    expect(types).not.toContain('TASK_EXECUTION_COMPLETED')
    expect(fake.calls.some(call => /INSERT INTO task_runtime_facts/.test(call.sql))).toBe(false)
  })

  it('marca a subtarefa informada como verified de forma idempotente', async () => {
    const fake = fakePool({ subtaskUpdateAffected: 0, subtaskExists: true, counts: { total: 1, finais: 1 } })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-820', motivo: 'ok', resolvedBy: 'teste', subtaskId: 1050,
    })

    expect(result.subtaskVerified).toBe(false) // já estava finalizada
    expect(result.completed).toBe(true)
  })

  it('rejeita subtarefa que não pertence à tarefa', async () => {
    const fake = fakePool({ subtaskUpdateAffected: 0, subtaskExists: false })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    await expect(handler.handle({
      taskId: 'task-p2-820', motivo: 'ok', resolvedBy: 'teste', subtaskId: 999999,
    })).rejects.toMatchObject({ code: 'subtask_not_found' })
    expect(fake.connection.rollback).toHaveBeenCalled()
  })

  it('sem subtarefas (total=0) retoma a análise em vez de disparar programação', async () => {
    const fake = fakePool({ blockersResolved: 1, counts: { total: 0, finais: 0 } })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-899', motivo: 'analista não gerou plano', resolvedBy: 'teste',
    })

    expect(result.completed).toBe(false)
    expect(result.requeued).toBe(true)
    const messages = fake.outboxMessages()
    const types = messages.map(message => message.type)
    expect(types).toContain('TASK_RESUME_REQUESTED')
    expect(types).not.toContain('TASK_READY_FOR_PROGRAMMING')
    const resume = messages.find(message => message.type === 'TASK_RESUME_REQUESTED')
    expect(resume?.payload.resumeAnalysis).toBe(true)
    expect(resume?.payload.reason).toBe('external_resolution')
  })

  it('retorna not_found para tarefa inexistente', async () => {
    const fake = fakePool({ task: null })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    await expect(handler.handle({
      taskId: 'task- fantasma', motivo: 'ok', resolvedBy: 'teste',
    })).rejects.toBeInstanceOf(ExternalResolutionError)
    await expect(handler.handle({ taskId: 'x', motivo: 'ok', resolvedBy: 'teste' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('exige motivo e resolvedBy', async () => {
    const fake = fakePool()
    const handler = new ExternalResolutionHandler(fake.pool as never)

    await expect(handler.handle({ taskId: 'task-p2-820', motivo: '', resolvedBy: 'teste' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(handler.handle({ taskId: 'task-p2-820', motivo: 'ok', resolvedBy: '' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })
})
