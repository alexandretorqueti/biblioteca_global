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
  /** Tarefa 972: request failed existente para reativação. */
  failedRequest?: { id: number; repo_path: string; base_branch: string; requested_commit: string } | null
  /** Tarefa 972: tombstone administrativo existente. */
  hasTombstone?: boolean
  /** Tarefa 972: idempotência — request já pending existe. */
  hasPendingRequest?: boolean
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
      // Tarefa 972: query de request failed para reativação
      if (/FROM deploy_requests[\s\S]*status = 'failed'/.test(sql)) {
        if (options.failedRequest) {
          return [[{
            id: options.failedRequest.id,
            status: 'failed',
            last_error: 'Deploy failed: merge conflict',
            batch_id: 'batch-123',
            repo_path: options.failedRequest.repo_path,
            base_branch: options.failedRequest.base_branch,
            requested_commit: options.failedRequest.requested_commit,
          }]]
        }
        return [[]]
      }
      // Tarefa 972: query de tombstone administrativo
      if (/Adjudicação administrativa sem deploy/.test(sql)) {
        return [[{ has_tombstone: options.hasTombstone ? 1 : 0 }]]
      }
      // Tarefa 972: UPDATE deploy_requests para reativação
      if (/UPDATE deploy_requests[\s\S]*SET status = 'pending'/.test(sql)) {
        return [{ affectedRows: 1 }]
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
    // Incidente 911: sem request prévio, a adjudicação precisa materializar um
    // tombeau cancelled na mesma transação para falhar o NOT EXISTS do recovery.
    const tombstones = withoutDeploy.calls.filter(call => /INSERT INTO deploy_requests/.test(call.sql))
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]?.sql).toContain("'cancelled'")
    expect(tombstones[0]?.sql).toContain('COALESCE(pmc.repo_path')
    expect(tombstones[0]?.params[0]).toContain('Adjudicação administrativa sem deploy')
    expect(tombstones[0]?.params[0]).toContain('blocker=external_resolution')

    const withDeploy = fakePool({ counts: { total: 1, finais: 1 } })
    await new ExternalResolutionHandler(withDeploy.pool as never).handle({
      taskId: 'task-p2-820', motivo: 'deploy explícito', resolvedBy: 'monitor', requestDeploy: true,
    })
    expect(withDeploy.calls.some(call => /UPDATE deploy_requests dr/.test(call.sql))).toBe(false)
    expect(withDeploy.calls.some(call => /INSERT INTO deploy_requests/.test(call.sql))).toBe(false)
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

  // === Tarefa 972: retry governado de request failed ===

  it('972: reativa request failed para pending com requestDeploy=true e enfileira dispatch', async () => {
    const fake = fakePool({
      counts: { total: 3, finais: 3 },
      failedRequest: {
        id: 42,
        repo_path: '/home/alexandre/codigofonte/biblioteca-global',
        base_branch: 'main',
        requested_commit: 'abc123def456',
      },
      hasTombstone: false,
    })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-966',
      motivo: 'Conflito resolvido manualmente pelo Monitor',
      resolvedBy: 'monitor',
      requestDeploy: true,
    })

    expect(result.ok).toBe(true)
    expect(result.completed).toBe(true)
    expect(result.deployRequested).toBe(true)
    expect(result.failedRequestReactivated).toBe(true)

    // Verificar UPDATE do deploy_request para pending
    const updateCall = fake.calls.find(call => /UPDATE deploy_requests[\s\S]*SET status = 'pending'/.test(call.sql))
    expect(updateCall).toBeDefined()
    expect(updateCall?.sql).toContain("last_error = NULL")
    expect(updateCall?.sql).toContain("finished_at = NULL")
    expect(updateCall?.params[0]).toBe(42)

    // Verificar dispatch enfileirado (não DEPLOY_REQUESTED, mas DEPLOY_BATCH_DISPATCH_REQUESTED)
    const messages = fake.outboxMessages()
    const types = messages.map(m => m.type)
    expect(types).toContain('DEPLOY_BATCH_DISPATCH_REQUESTED')
    expect(types).not.toContain('DEPLOY_REQUESTED') // não emite novo DEPLOY_REQUESTED

    const dispatch = messages.find(m => m.type === 'DEPLOY_BATCH_DISPATCH_REQUESTED')
    expect(dispatch?.payload.reason).toBe('external_resolution_retry')
    expect(dispatch?.payload.reactivatedFromFailed).toBe(true)
    expect(dispatch?.payload.repository).toBe('/home/alexandre/codigofonte/biblioteca-global')
    expect(dispatch?.payload.baseBranch).toBe('main')
    expect(dispatch?.payload.expectedCommit).toBe('abc123def456')

    // Auditoria inclui failedRequestReactivated
    const auditCall = fake.calls.find(call => /INSERT INTO tarefa_eventos/.test(call.sql))
    const auditPayload = JSON.parse(String(auditCall?.params[3]))
    expect(auditPayload.failedRequestReactivated).toBe(true)

    expect(fake.connection.commit).toHaveBeenCalled()
  })

  it('972: NÃO reativa request quando existe tombstone administrativo (cancelled)', async () => {
    const fake = fakePool({
      counts: { total: 2, finais: 2 },
      failedRequest: {
        id: 50,
        repo_path: '/repo',
        base_branch: 'main',
        requested_commit: 'xyz789',
      },
      hasTombstone: true, // Adjudicação administrativa existe
    })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-955',
      motivo: 'Tentativa de retry sobre adjudicação',
      resolvedBy: 'monitor',
      requestDeploy: true,
    })

    expect(result.ok).toBe(true)
    expect(result.completed).toBe(true)
    // Tombstone preservado — nem reativação nem dispatch
    expect(result.failedRequestReactivated).toBe(false)
    expect(result.deployRequested).toBe(false)

    // Nenhum UPDATE deploy_requests para pending
    const updateCall = fake.calls.find(call => /UPDATE deploy_requests[\s\S]*SET status = 'pending'/.test(call.sql))
    expect(updateCall).toBeUndefined()

    // Nenhum dispatch enfileirado
    const messages = fake.outboxMessages()
    const types = messages.map(m => m.type)
    expect(types).not.toContain('DEPLOY_BATCH_DISPATCH_REQUESTED')
    expect(types).not.toContain('DEPLOY_REQUESTED')
  })

  it('972: sem request failed e sem tombstone, emite DEPLOY_REQUESTED normalmente', async () => {
    const fake = fakePool({
      counts: { total: 2, finais: 2 },
      failedRequest: null, // nenhum request failed
      hasTombstone: false,
    })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-820',
      motivo: 'Deploy explícito',
      resolvedBy: 'monitor',
      requestDeploy: true,
    })

    expect(result.ok).toBe(true)
    expect(result.deployRequested).toBe(true)
    expect(result.failedRequestReactivated).toBe(false)

    const messages = fake.outboxMessages()
    const types = messages.map(m => m.type)
    expect(types).toContain('DEPLOY_REQUESTED') // caminho normal
    expect(types).not.toContain('DEPLOY_BATCH_DISPATCH_REQUESTED')
  })

  it('972: sem requestDeploy mantém semântica de cancelamento e tombstone', async () => {
    const fake = fakePool({
      counts: { total: 2, finais: 2 },
      failedRequest: {
        id: 60,
        repo_path: '/repo',
        base_branch: 'main',
        requested_commit: 'aaa111',
      },
      hasTombstone: false,
    })
    const handler = new ExternalResolutionHandler(fake.pool as never)

    const result = await handler.handle({
      taskId: 'task-p2-820',
      motivo: 'Conclusão sem deploy',
      resolvedBy: 'monitor',
      // requestDeploy ausente
    })

    expect(result.ok).toBe(true)
    expect(result.deployRequested).toBe(false)
    expect(result.failedRequestReactivated).toBe(false)

    // cancelUnstartedDeployRequests deve ser chamado (UPDATE deploy_requests ... cancelled)
    const cancelCall = fake.calls.find(call => /UPDATE deploy_requests dr/.test(call.sql))
    expect(cancelCall).toBeDefined()
    expect(cancelCall?.sql).toContain("dr.status='cancelled'")

    // Tombstone criado
    const tombstoneCall = fake.calls.find(call => /INSERT INTO deploy_requests[\s\S]*'cancelled'/.test(call.sql))
    expect(tombstoneCall).toBeDefined()
  })

  it('972: rollback em falha de atualização do deploy_request', async () => {
    const fake = fakePool({
      counts: { total: 2, finais: 2 },
      failedRequest: {
        id: 70,
        repo_path: '/repo',
        base_branch: 'main',
        requested_commit: 'bbb222',
      },
      hasTombstone: false,
    })
    // Simular falha no UPDATE deploy_requests
    const originalQuery = fake.connection.query.getMockImplementation()
    fake.connection.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/UPDATE deploy_requests[\s\S]*SET status = 'pending'/.test(sql)) {
        throw new Error('DB connection lost')
      }
      return originalQuery!(sql, params)
    })

    const handler = new ExternalResolutionHandler(fake.pool as never)

    await expect(handler.handle({
      taskId: 'task-p2-820',
      motivo: 'Retry com falha de DB',
      resolvedBy: 'monitor',
      requestDeploy: true,
    })).rejects.toThrow('DB connection lost')

    expect(fake.connection.rollback).toHaveBeenCalled()
    expect(fake.connection.commit).not.toHaveBeenCalled()
  })
})
