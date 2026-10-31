// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { TaskUnblockedConsumer, createTaskUnblockedMessage, TASK_UNBLOCKED_EVENT_TYPE } from '../src/monitor/index.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'

interface FakeOptions {
  taskIdResolvable?: boolean
  pendingGroups?: Array<{ repo_path: string; base_branch: string; requested_commit: string }>
  stalePendingRequests?: number
  verificationSubtasks?: Array<{ id: number; seq: number }>
  verificationUpdateAffectedRows?: number[]
  /** Subtarefa do bloqueio terminal (SELECT ... FROM subtarefas s WHERE s.id = ?). */
  terminalSubtask?: { id: number; seq: number; status: string; generation?: number } | null
  /** Geração máxima das subtarefas da tarefa. */
  maxGeneration?: number
  /** subtarefa_id retornado pela resolução via bloqueios. */
  blockSubtaskId?: number | null
  /** affectedRows do UPDATE de reabertura (failed/blocked → pending). */
  pendingUpdateAffectedRows?: number[]
  /** Runner Git injetado no consumidor (refresh do requested_commit obsoleto). */
  git?: (args: string[], cwd: string) => Promise<{ ok: boolean; stdout: string }>
  /** Linha retornada pelo SELECT seed de pedidos `failed` (padrão: primeiro grupo pending). */
  failedSeed?: { repo_path: string; base_branch: string; requested_commit: string; batch_id?: string | null } | null
}

function fakeEnvironment(options: FakeOptions = {}) {
  const queries: { sql: string; params: unknown[]; via: 'pool' | 'connection' }[] = []
  const record = (via: 'pool' | 'connection') => async (sql: string, params?: unknown[]) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params: params ?? [], via })
    if (normalized.startsWith('DELETE dr FROM deploy_requests')) {
      return [{ affectedRows: options.stalePendingRequests ?? 1 }, []]
    }
    if (normalized.startsWith('SELECT subtarefa_id FROM bloqueios')) {
      const subtarefaId = options.blockSubtaskId ?? null
      return [subtarefaId == null ? [] : [{ subtarefa_id: subtarefaId }], []]
    }
    if (normalized.startsWith('SELECT s.id, s.seq, s.status, s.generation')) {
      return [options.terminalSubtask == null ? [] : [{
        id: options.terminalSubtask.id,
        seq: options.terminalSubtask.seq,
        status: options.terminalSubtask.status,
        generation: options.terminalSubtask.generation ?? 1,
      }], []]
    }
    if (normalized.startsWith('SELECT MAX(generation) AS max_generation')) {
      return [[{ max_generation: options.maxGeneration ?? 1 }], []]
    }
    if (normalized.startsWith("UPDATE subtarefas SET status='pending'")) {
      return [{ affectedRows: options.pendingUpdateAffectedRows?.shift() ?? 1 }, []]
    }
    if (normalized.startsWith('SELECT s.id, s.seq FROM subtarefas')) {
      return [options.verificationSubtasks ?? [], []]
    }
    if (normalized.startsWith("UPDATE subtarefas SET status='verifying'")) {
      return [{ affectedRows: options.verificationUpdateAffectedRows?.shift() ?? 1 }, []]
    }
    if (normalized.includes('FROM tarefas')) {
      return [options.taskIdResolvable === false ? [] : [{ id: 886 }], []]
    }
    if (normalized.includes('FROM deploy_requests')) {
      const groups = options.pendingGroups ?? [
        { repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc123' },
      ]
      // O SELECT seed (pedidos `failed` FOR UPDATE) e o SELECT de grupos
      // (pedidos `pending`) compartilham o padrão; distinguir pelo filtro de
      // status permite simular o refresh do requested_commit entre os dois.
      if (normalized.includes("dr.status='failed'")) {
        const seed = options.failedSeed !== undefined ? options.failedSeed : groups[0] ?? null
        return [seed ? [seed] : [], []]
      }
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
  const consumer = options.git
    ? new TaskUnblockedConsumer(pool, eventsSink, options.git)
    : new TaskUnblockedConsumer(pool, eventsSink)
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

  it('deploy_member_conflict remove pedido pending obsoleto e solicita novo deploy na mesma transação', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(unblockedMessage({ blockReason: 'deploy_member_conflict' }))

    // O pedido pending com requested_commit obsoleto precisa ser removido,
    // senão needsRequestPreparation pula o novo DEPLOY_REQUESTED
    // (deploy_request_already_persisted) e o compose repete o conflito em loop.
    const stale = env.queries.find(q => q.sql.includes('DELETE dr FROM deploy_requests'))
    expect(stale).toBeDefined()
    expect(stale!.via).toBe('connection')
    expect(stale!.sql).toContain("status='pending'")
    expect(stale!.sql).toContain('batch_id IS NULL')
    expect(stale!.params).toEqual([886])

    const requests = env.outbox('DEPLOY_REQUESTED')
    expect(requests).toHaveLength(1)
    expect(requests[0].via).toBe('connection')
    expect(requests[0].params[3]).toBe('task-p1-886')
    expect(JSON.parse(requests[0].params[5] as string)).toMatchObject({
      reason: 'deploy_member_conflict_resolved',
      resumedBy: 'monitor',
    })
    // Dispatches órfãos com o SHA obsoleto são removidos do outbox
    const orphanDispatch = env.queries.find(q => q.sql.includes('DELETE FROM motor_outbox') && q.sql.includes('DEPLOY_BATCH_DISPATCH_REQUESTED'))
    expect(orphanDispatch).toBeDefined()
    expect(orphanDispatch!.via).toBe('connection')
    expect(orphanDispatch!.params).toEqual(['task-p1-886'])
    expect(env.connection.commit).toHaveBeenCalledOnce()
    expect(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')).toHaveLength(0)
    expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload)
      .toMatchObject({ action: 'deploy_request_refreshed', staleRequestsRemoved: 1 })
  })

  it('deploy_member_conflict sem pedido pending (redelivery): ainda solicita novo deploy', async () => {
    const env = fakeEnvironment({ stalePendingRequests: 0 })

    await env.consumer.handle(unblockedMessage({ blockReason: 'deploy_member_conflict' }))

    expect(env.outbox('DEPLOY_REQUESTED')).toHaveLength(1)
    expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload)
      .toMatchObject({ action: 'deploy_request_refreshed', staleRequestsRemoved: 0 })
  })

  it('deploy_member_conflict remove pedido failed de lote terminado (todos os membros conflitaram)', async () => {
    const env = fakeEnvironment()

    await env.consumer.handle(unblockedMessage({ blockReason: 'deploy_member_conflict' }))

    // Quando TODOS os membros conflitam, o batch falha e o pedido permanece
    // `failed` com requested_commit obsoleto. Sem removê-lo, o accept do novo
    // DEPLOY_REQUESTED pula (deploy_request_already_persisted) e a retomada é
    // no-op — incidente task-p2-1011.
    const stale = env.queries.find(q => q.sql.includes('DELETE dr FROM deploy_requests'))
    expect(stale).toBeDefined()
    expect(stale!.sql).toContain("dr.status='failed'")
    // Pedidos failed atrelados a lote ainda em andamento NÃO podem ser removidos
    expect(stale!.sql).toContain('NOT EXISTS')
    expect(stale!.sql).toContain('deploy_batches')
    expect(stale!.sql).toMatch(/b\.status IN \('pending','running'\)/)
    expect(env.outbox('DEPLOY_REQUESTED')).toHaveLength(1)
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

  it('subtask_verification_failed: reabre subtarefa e enfileira verificação na mesma transação', async () => {
    const env = fakeEnvironment({ verificationSubtasks: [{ id: 901, seq: 3 }] })

    await env.consumer.handle(unblockedMessage({ blockReason: 'subtask_verification_failed' }))

    const update = env.queries.find(q => q.sql.startsWith("UPDATE subtarefas SET status='verifying'"))
    expect(update).toBeDefined()
    expect(update!.via).toBe('connection')
    expect(update!.sql).toContain("status='blocked'")

    const verifications = env.outbox('SUBTASK_VERIFICATION_REQUESTED')
    expect(verifications).toHaveLength(1)
    expect(verifications[0].via).toBe('connection')
    expect(verifications[0].params[2]).toBe('motor.commands')
    expect(JSON.parse(verifications[0].params[5] as string)).toMatchObject({
      subtaskId: 901, seq: 3, resumedBy: 'monitor',
    })
    expect(env.connection.commit).toHaveBeenCalledOnce()
  })

  it('redelivery do desbloqueio não duplica pedido de verificação', async () => {
    const env = fakeEnvironment({
      verificationSubtasks: [{ id: 901, seq: 3 }],
      verificationUpdateAffectedRows: [1, 0],
    })
    const message = unblockedMessage({ blockReason: 'subtask_verification_failed' })

    await env.consumer.handle(message)
    await env.consumer.handle(message)

    expect(env.outbox('SUBTASK_VERIFICATION_REQUESTED')).toHaveLength(1)
    expect(env.connection.commit).toHaveBeenCalledTimes(2)
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

describe('TaskUnblockedConsumer — retomada de falha terminal de subtarefa (tarefa 1043)', () => {
  it("worker_exhausted: reverte a subtarefa 'failed' do bloqueio para 'pending' e emite pedido de execução na mesma transação", async () => {
    const env = fakeEnvironment({ terminalSubtask: { id: 1403, seq: 3, status: 'failed' } })

    await env.consumer.handle(unblockedMessage({ blockReason: 'worker_exhausted', subtaskId: 1403 }))

    // Reabertura condicionada a failed/blocked com resultado limpo (redelivery idempotente)
    const update = env.queries.find(q => q.sql.startsWith("UPDATE subtarefas SET status='pending'"))
    expect(update).toBeDefined()
    expect(update!.via).toBe('connection')
    expect(update!.sql).toContain("status IN ('failed','blocked')")
    expect(update!.sql).toContain('resultado=NULL')
    expect(update!.params).toEqual([1403])

    // Pedido durável de retomada na mesma transação (reserveNextSubtask faz o
    // claim pending → running e emite SUBTASK_EXECUTION_REQUESTED)
    const ready = env.outbox('TASK_READY_FOR_PROGRAMMING')
    expect(ready).toHaveLength(1)
    expect(ready[0].via).toBe('connection')
    expect(ready[0].params[2]).toBe('motor.commands')
    expect(ready[0].params[3]).toBe('task-p1-886')
    expect(JSON.parse(ready[0].params[5] as string)).toMatchObject({
      subtaskId: 1403, seq: 3, blockReason: 'worker_exhausted', resumedBy: 'monitor',
    })
    expect(ready[0].sql).toContain('NOT EXISTS')
    expect(env.connection.commit).toHaveBeenCalledOnce()
    expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload)
      .toMatchObject({ blockReason: 'worker_exhausted', action: 'subtask_reopened_for_programming', subtaskId: 1403, reopened: true })
  })

  it("subtask_terminal_failure: reverte a subtarefa 'blocked' para 'pending' e emite pedido de execução", async () => {
    const env = fakeEnvironment({ terminalSubtask: { id: 1403, seq: 3, status: 'blocked' } })

    await env.consumer.handle(unblockedMessage({ blockReason: 'subtask_terminal_failure', subtaskId: 1403 }))

    const update = env.queries.find(q => q.sql.startsWith("UPDATE subtarefas SET status='pending'"))
    expect(update).toBeDefined()
    expect(update!.params).toEqual([1403])
    expect(env.outbox('TASK_READY_FOR_PROGRAMMING')).toHaveLength(1)
    expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload)
      .toMatchObject({ blockReason: 'subtask_terminal_failure', action: 'subtask_reopened_for_programming', reopened: true })
  })

  it('resolve a subtarefa via bloqueios pelo blockId do payload quando não há subtaskId', async () => {
    const env = fakeEnvironment({
      blockSubtaskId: 1403,
      terminalSubtask: { id: 1403, seq: 3, status: 'failed' },
    })

    await env.consumer.handle(unblockedMessage({ blockReason: 'worker_exhausted', blockId: 77 }))

    const blockSelect = env.queries.find(q => q.sql.startsWith('SELECT subtarefa_id FROM bloqueios'))
    expect(blockSelect).toBeDefined()
    expect(blockSelect!.sql).toContain('id = ?')
    expect(blockSelect!.params).toEqual([886, 77])

    expect(env.outbox('TASK_READY_FOR_PROGRAMMING')).toHaveLength(1)
    expect(JSON.parse(env.outbox('TASK_READY_FOR_PROGRAMMING')[0].params[5] as string)).toMatchObject({ subtaskId: 1403 })
  })

  it('sem blockId no payload: resolve pelo bloqueio mais recente do mesmo motivo', async () => {
    const env = fakeEnvironment({
      blockSubtaskId: 1403,
      terminalSubtask: { id: 1403, seq: 3, status: 'blocked' },
    })

    await env.consumer.handle(unblockedMessage({ blockReason: 'subtask_terminal_failure', blockId: undefined }))

    const blockSelect = env.queries.find(q => q.sql.startsWith('SELECT subtarefa_id FROM bloqueios'))
    expect(blockSelect).toBeDefined()
    expect(blockSelect!.sql).toContain('block_reason = ?')
    expect(blockSelect!.params).toEqual([886, 'subtask_terminal_failure'])
    expect(env.outbox('TASK_READY_FOR_PROGRAMMING')).toHaveLength(1)
  })

  it('redelivery da mesma TASK_UNBLOCKED não duplica pedidos nem reabre subtarefa já pendente', async () => {
    const options = { terminalSubtask: { id: 1403, seq: 3, status: 'failed' } }
    const env = fakeEnvironment(options)
    const message = unblockedMessage({ blockReason: 'worker_exhausted', subtaskId: 1403 })

    await env.consumer.handle(message)
    expect(env.outbox('TASK_READY_FOR_PROGRAMMING')).toHaveLength(1)

    // Primeira entrega reabriu: a subtarefa agora está pendente (ou já claimada)
    options.terminalSubtask = { id: 1403, seq: 3, status: 'pending' }
    await env.consumer.handle(message)

    expect(env.outbox('TASK_READY_FOR_PROGRAMMING')).toHaveLength(1)
    const updates = env.queries.filter(q => q.sql.startsWith("UPDATE subtarefas SET status='pending'"))
    expect(updates).toHaveLength(1)
    expect(env.events.at(-1)!.payload).toMatchObject({ action: 'subtask_not_reopenable', reopened: false })
  })

  it('não reabre subtarefa verified/superseded nem publica pedido', async () => {
    for (const status of ['verified', 'superseded']) {
      const env = fakeEnvironment({ terminalSubtask: { id: 1403, seq: 3, status } })

      await env.consumer.handle(unblockedMessage({ blockReason: 'worker_exhausted', subtaskId: 1403 }))

      expect(env.queries.find(q => q.sql.startsWith("UPDATE subtarefas SET status='pending'"))).toBeUndefined()
      expect(env.outbox('TASK_READY_FOR_PROGRAMMING')).toHaveLength(0)
      expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload)
        .toMatchObject({ action: 'subtask_not_reopenable', reopened: false })
    }
  })

  it('subtarefa de geração antiga: não reabre e cai no fallback durável', async () => {
    const env = fakeEnvironment({
      terminalSubtask: { id: 1403, seq: 3, status: 'failed', generation: 1 },
      maxGeneration: 2,
    })

    await env.consumer.handle(unblockedMessage({ blockReason: 'worker_exhausted', subtaskId: 1403 }))

    expect(env.queries.find(q => q.sql.startsWith("UPDATE subtarefas SET status='pending'"))).toBeUndefined()
    const ready = env.outbox('TASK_READY_FOR_PROGRAMMING')
    expect(ready).toHaveLength(1)
    expect(JSON.parse(ready[0].params[5] as string)).not.toHaveProperty('subtaskId')
    expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload)
      .toMatchObject({ action: 'task_ready_for_programming_enqueued' })
  })

  it('bloqueio sem subtaskId utilizável: fallback TASK_READY_FOR_PROGRAMMING com auditoria', async () => {
    const env = fakeEnvironment({ blockSubtaskId: null })

    await env.consumer.handle(unblockedMessage({ blockReason: 'worker_exhausted', blockId: 77 }))

    const ready = env.outbox('TASK_READY_FOR_PROGRAMMING')
    expect(ready).toHaveLength(1)
    expect(ready[0].via).toBe('connection')
    const payload = JSON.parse(ready[0].params[5] as string)
    expect(payload).toMatchObject({ reason: 'unblocked_worker_exhausted', blockReason: 'worker_exhausted', resumedBy: 'monitor' })
    expect(payload).not.toHaveProperty('subtaskId')
    expect(ready[0].sql).toContain('NOT EXISTS')
    // Auditoria em tarefa_eventos via TaskEventSink
    expect(env.events.find(e => e.evento === 'task_resumed_by_monitor')!.payload)
      .toMatchObject({ blockReason: 'worker_exhausted', action: 'task_ready_for_programming_enqueued', subtaskId: null, reopened: false })
    expect(env.connection.commit).toHaveBeenCalledOnce()
  })

  it('cenário 1403: falha → bloqueio → resolução retoma exatamente pela subtarefa 1403', async () => {
    // 1403 falhou (worker_exhausted → status 'failed', bloqueio id 77);
    // 1404/1405 seguem pendentes e não podem ser tocadas — a retomada passa
    // pelo reserveNextSubtask a partir da subtarefa reaberta.
    const env = fakeEnvironment({
      blockSubtaskId: 1403,
      terminalSubtask: { id: 1403, seq: 3, status: 'failed' },
    })

    await env.consumer.handle(unblockedMessage({ blockReason: 'worker_exhausted', blockId: 77 }))

    // Somente 1403 é reaberta; nenhuma outra subtarefa é atualizada
    const updates = env.queries.filter(q => q.sql.startsWith('UPDATE subtarefas'))
    expect(updates).toHaveLength(1)
    expect(updates[0].params).toEqual([1403])

    // O pedido de retomada carrega a subtarefa bloqueada (1403) como ponto de reinício
    const ready = env.outbox('TASK_READY_FOR_PROGRAMMING')
    expect(ready).toHaveLength(1)
    expect(JSON.parse(ready[0].params[5] as string)).toMatchObject({ subtaskId: 1403, seq: 3 })

    // Nenhum outro fluxo (verificação/deploy) é acionado por este motivo
    expect(env.outbox('SUBTASK_VERIFICATION_REQUESTED')).toHaveLength(0)
    expect(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')).toHaveLength(0)
    expect(env.outbox('TASK_RESUME_REQUESTED')).toHaveLength(0)
  })

  // Regressão task-p2-1047 (2026-10-31): gate pre_deploy reprovado, Monitor
  // commita a correção na branch de integração; o dispatch com o
  // `requested_commit` obsoleto recompunha a cadeia ANTIGA e o gate reprovava
  // de novo no mesmo motivo (loop — família dos incidentes 979/1011).
  describe('refresh do requested_commit obsoleto (fast-forward da integração)', () => {
    function gitStub(handlers: { revParse?: { ok: boolean; stdout: string }; ancestor?: boolean }) {
      const calls: Array<{ args: string[]; cwd: string }> = []
      const runner = async (args: string[], cwd: string) => {
        calls.push({ args, cwd })
        if (args[0] === 'rev-parse') return handlers.revParse ?? { ok: false, stdout: '' }
        if (args[0] === 'merge-base') return handlers.ancestor === false ? { ok: false, stdout: '' } : { ok: true, stdout: '' }
        return { ok: false, stdout: '' }
      }
      return { runner, calls }
    }

    it('HEAD da integração descendente do commit obsoleto → atualiza o pedido e despacha o HEAD novo', async () => {
      const git = gitStub({ revParse: { ok: true, stdout: 'fff999aaa\n' } })
      const env = fakeEnvironment({
        git: git.runner,
        failedSeed: { repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc1234', batch_id: null },
        // Após o UPDATE, o SELECT de grupos já enxerga o commit novo.
        pendingGroups: [{ repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'fff999aaa' }],
      })

      await env.consumer.handle(unblockedMessage({ blockReason: 'pre_deploy_gate_failed' }))

      expect(git.calls[0].args).toEqual(['rev-parse', '--verify', 'motor-v3-work/integration-task-p1-886^{commit}'])
      expect(git.calls[1].args).toEqual(['merge-base', '--is-ancestor', 'abc1234', 'fff999aaa'])
      const refresh = env.queries.find(q => q.sql.includes('SET requested_commit=?'))
      expect(refresh).toBeDefined()
      expect(refresh!.via).toBe('connection')
      expect(refresh!.params).toEqual(['fff999aaa', 886, 'abc1234'])
      const dispatch = JSON.parse(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')[0].params[5] as string)
      expect(dispatch.expectedCommit).toBe('fff999aaa')
      const refreshed = env.events.find(e => e.evento === 'task_resume_deploy_commit_refreshed')
      expect(refreshed!.payload).toMatchObject({ staleCommit: 'abc1234', headCommit: 'fff999aaa' })
    })

    it('branch divergente (não descendente) → mantém o commit gravado', async () => {
      const git = gitStub({ revParse: { ok: true, stdout: 'fff999aaa\n' }, ancestor: false })
      const env = fakeEnvironment({
        git: git.runner,
        failedSeed: { repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc1234', batch_id: null },
        pendingGroups: [{ repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc1234' }],
      })

      await env.consumer.handle(unblockedMessage({ blockReason: 'pre_deploy_gate_failed' }))

      expect(git.calls[1].args).toEqual(['merge-base', '--is-ancestor', 'abc1234', 'fff999aaa'])
      expect(env.queries.find(q => q.sql.includes('SET requested_commit=?'))).toBeUndefined()
      const dispatch = JSON.parse(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')[0].params[5] as string)
      expect(dispatch.expectedCommit).toBe('abc1234')
    })

    it('HEAD igual ao commit gravado → não consulta ancestralidade nem atualiza', async () => {
      const git = gitStub({ revParse: { ok: true, stdout: 'abc1234\n' } })
      const env = fakeEnvironment({
        git: git.runner,
        failedSeed: { repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc1234', batch_id: null },
        pendingGroups: [{ repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc1234' }],
      })

      await env.consumer.handle(unblockedMessage({ blockReason: 'pre_deploy_gate_failed' }))

      expect(git.calls).toHaveLength(1)
      expect(env.queries.find(q => q.sql.includes('SET requested_commit=?'))).toBeUndefined()
    })

    it('falha de Git (branch/repo inacessível) → degrada para o comportamento histórico', async () => {
      const git = gitStub({ revParse: { ok: false, stdout: '' } })
      const env = fakeEnvironment({
        git: git.runner,
        failedSeed: { repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc1234', batch_id: null },
        pendingGroups: [{ repo_path: '/repo/biblioteca-global', base_branch: 'base-desenvolvimento', requested_commit: 'abc1234' }],
      })

      await env.consumer.handle(unblockedMessage({ blockReason: 'pre_deploy_gate_failed' }))

      expect(env.queries.find(q => q.sql.includes('SET requested_commit=?'))).toBeUndefined()
      expect(env.outbox('DEPLOY_BATCH_DISPATCH_REQUESTED')).toHaveLength(1)
    })
  })
})
