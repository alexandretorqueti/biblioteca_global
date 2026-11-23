// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import { DeployRepository, type DeployBatch } from '../src/deploy/DeployRepository.js'
import type { OperationLogEntry } from '../src/commands/index.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/index.js'

/**
 * Subtarefa 2 — motor-deploy-reconcile-hardening: reconcile com retry.
 *
 * (a) estado não-terminal em reconcile() (script ainda ativo, ou marcador ausente sem
 *     timeout) → nova DEPLOY_RECONCILIATION_REQUESTED com executionId/correlationId
 *     únicos (sufixo timestamp) e INSERT com timestamp adiado no motor_outbox, com log
 *     estruturado da decisão.
 * (b) dois ciclos consecutivos de enqueueReconciliationForRunning produzem
 *     correlation_id distintos para o mesmo batch — a dedup por logical key
 *     (type,task_id,correlation_id) do outbox não engole a reemissão.
 * (c) paridade: estados terminais (success/failed/invalid/absent+timeout) e
 *     receiveResult mantêm exatamente o comportamento anterior.
 */

function makeBatch(overrides: Partial<DeployBatch> = {}): DeployBatch {
  return {
    batchId: 'batch-reconcile-retry',
    repoPath: '/repo',
    baseBranch: 'base-desenvolvimento',
    expectedCommit: 'abc1234567890',
    status: 'running',
    remotePid: '12345',
    remoteStatusPath: '/tmp/biblioteca-global-x.status',
    startedAt: new Date(Date.now() - 60_000),
    workspacePath: '/worktree/batch',
    gateJobId: 1,
    ...overrides,
  }
}

function reconcileMessage(batchId = 'batch-reconcile-retry'): QueueMessage {
  return createQueueMessage({ type: 'DEPLOY_RECONCILIATION_REQUESTED', taskId: 'system', executionId: `deploy-reconcile-${batchId}-seed`, payload: { batchId } })
}

function captureLogger() {
  const entries: OperationLogEntry[] = []
  const logger = { async append(entry: OperationLogEntry) { entries.push(entry) } }
  return { logger, entries }
}

/**
 * Caminho de construção direta do 15º argumento do DeployConsumer (reconcileRetrySeconds):
 * repository, gate, remote, logger, commandPolicies, hostRepoRoot, script, timeoutMs,
 * worktrees, operationState, governedFailureHandler, githubKnownHostsPath,
 * githubPreflightTimeoutMs, taskEvents, reconcileRetrySeconds.
 */
function consumerWithRetrySeconds(repository: DeployRepository, remote: never, logger: ReturnType<typeof captureLogger>['logger'], retrySeconds: number): DeployConsumer {
  return new DeployConsumer(repository, {} as never, remote, logger, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, retrySeconds)
}

describe('DeployConsumer.reconcile — reagendamento de estado não-terminal (retry)', () => {
  it("state 'active' agenda nova reconciliação com executionId/correlation únicos e defer, sem fechar o batch", async () => {
    const { logger, entries } = captureLogger()
    const repository = {
      runningBatches: vi.fn().mockResolvedValue([makeBatch()]),
      scheduleReconciliation: vi.fn().mockResolvedValue(undefined),
      completeBatch: vi.fn().mockResolvedValue([]),
    } as unknown as DeployRepository
    const remote = { status: vi.fn().mockResolvedValue({ state: 'active', status: null, diagnostic: 'script em execução' }) } as never

    const consumer = new DeployConsumer(repository, {} as never, remote, logger)
    await (consumer as unknown as { reconcile(m: QueueMessage): Promise<void> }).reconcile(reconcileMessage())

    expect(repository.scheduleReconciliation).toHaveBeenCalledTimes(1)
    expect(repository.completeBatch).not.toHaveBeenCalled()
    const [source, batchId, executionId, correlationId, deferMs] = repository.scheduleReconciliation.mock.calls[0]
    expect(source.type).toBe('DEPLOY_RECONCILIATION_REQUESTED')
    expect(batchId).toBe('batch-reconcile-retry')
    expect(executionId).toMatch(/^deploy-reconcile-batch-reconcile-retry-\d{13}$/)
    expect(correlationId).toMatch(/^deploy-reconcile-cycle-batch-reconcile-retry-\d{13}$/)
    expect(deferMs).toBe(300_000) // padrão compatível com o ciclo de 5min do reconciliador
    // log estruturado da decisão
    const actionEntry = entries.find(e => e.phase === 'action' && e.primitiveCode === 'deploy_reconciliation_rescheduled')
    expect(actionEntry).toBeDefined()
    expect(actionEntry?.outcome).toBe('succeeded')
    expect(actionEntry?.result?.remoteState).toBe('active')
  })

  it('marcador ausente sem timeout também reagenda (antes era descartado em silêncio)', async () => {
    const { logger } = captureLogger()
    const repository = {
      runningBatches: vi.fn().mockResolvedValue([makeBatch({ remoteStatusPath: null, remotePid: null })]),
      scheduleReconciliation: vi.fn().mockResolvedValue(undefined),
      completeBatch: vi.fn().mockResolvedValue([]),
    } as unknown as DeployRepository
    const consumer = new DeployConsumer(repository, {} as never, { status: vi.fn() } as never, logger)

    await (consumer as unknown as { reconcile(m: QueueMessage): Promise<void> }).reconcile(reconcileMessage())

    expect(repository.scheduleReconciliation).toHaveBeenCalledTimes(1)
    expect(repository.completeBatch).not.toHaveBeenCalled()
  })

  it('dois reconcile seguidos para o mesmo batch geram correlation distintos (dedup não engole)', async () => {
    const { logger } = captureLogger()
    const repository = {
      runningBatches: vi.fn().mockResolvedValue([makeBatch()]),
      scheduleReconciliation: vi.fn().mockResolvedValue(undefined),
      completeBatch: vi.fn().mockResolvedValue([]),
    } as unknown as DeployRepository
    const remote = { status: vi.fn().mockResolvedValue({ state: 'active', status: null, diagnostic: null }) } as never
    const consumer = new DeployConsumer(repository, {} as never, remote, logger)

    await (consumer as unknown as { reconcile(m: QueueMessage): Promise<void> }).reconcile(reconcileMessage())
    await new Promise(resolve => setTimeout(resolve, 2))
    await (consumer as unknown as { reconcile(m: QueueMessage): Promise<void> }).reconcile(reconcileMessage())

    const correlations = repository.scheduleReconciliation.mock.calls.map(call => call[3] as string)
    expect(correlations).toHaveLength(2)
    expect(correlations[0]).not.toBe(correlations[1])
  })

  it('intervalo de reagendamento é configurável (15º argumento, env na produção)', async () => {
    const { logger } = captureLogger()
    const repository = {
      runningBatches: vi.fn().mockResolvedValue([makeBatch()]),
      scheduleReconciliation: vi.fn().mockResolvedValue(undefined),
      completeBatch: vi.fn().mockResolvedValue([]),
    } as unknown as DeployRepository
    const remote = { status: vi.fn().mockResolvedValue({ state: 'active', status: null, diagnostic: null }) } as never

    const consumer = consumerWithRetrySeconds(repository, remote, logger, 90)
    await (consumer as unknown as { reconcile(m: QueueMessage): Promise<void> }).reconcile(reconcileMessage())
    expect(repository.scheduleReconciliation.mock.calls[0][4]).toBe(90_000)
  })

  it('batch que não está mais running é ignorado sem interação (paridade)', async () => {
    const { logger } = captureLogger()
    const repository = {
      runningBatches: vi.fn().mockResolvedValue([]),
      scheduleReconciliation: vi.fn(),
      completeBatch: vi.fn(),
    } as unknown as DeployRepository
    const consumer = new DeployConsumer(repository, {} as never, { status: vi.fn() } as never, logger)

    await (consumer as unknown as { reconcile(m: QueueMessage): Promise<void> }).reconcile(reconcileMessage('batch-fantasma'))

    expect(repository.scheduleReconciliation).not.toHaveBeenCalled()
    expect(repository.completeBatch).not.toHaveBeenCalled()
  })
})

describe('DeployConsumer.reconcile/receiveResult — paridade dos estados terminais', () => {
  const terminalCases: Array<{ state: 'success' | 'failed' | 'invalid'; status: string | null; expectedSuccess: boolean; expectedReasonFragment?: string }> = [
    { state: 'success', status: 'success', expectedSuccess: true },
    { state: 'failed', status: 'failed:1', expectedSuccess: false, expectedReasonFragment: 'script blue-green retornou failed:1' },
    { state: 'invalid', status: 'garbage', expectedSuccess: false, expectedReasonFragment: 'status remoto inválido' },
  ]

  for (const { state, status, expectedSuccess, expectedReasonFragment } of terminalCases) {
    it(`state '${state}' fecha o batch exatamente como antes e NÃO reagenda`, async () => {
      const { logger } = captureLogger()
      const repository = {
        runningBatches: vi.fn().mockResolvedValue([makeBatch()]),
        scheduleReconciliation: vi.fn(),
        completeBatch: vi.fn().mockResolvedValue(['99']),
      } as unknown as DeployRepository
      const remote = { status: vi.fn().mockResolvedValue({ state, status, diagnostic: null }) } as never
      const consumer = new DeployConsumer(repository, {} as never, remote, logger)

      await (consumer as unknown as { reconcile(m: QueueMessage): Promise<void> }).reconcile(reconcileMessage())

      expect(repository.scheduleReconciliation).not.toHaveBeenCalled()
      expect(repository.completeBatch).toHaveBeenCalledTimes(1)
      const [batchId, success, reason] = repository.completeBatch.mock.calls[0]
      expect(batchId).toBe('batch-reconcile-retry')
      expect(success).toBe(expectedSuccess)
      if (expectedReasonFragment) expect(String(reason)).toContain(expectedReasonFragment)
    })
  }

  it('absent + timeout falha o batch (terminal, sem reagendamento)', async () => {
    const { logger } = captureLogger()
    const repository = {
      runningBatches: vi.fn().mockResolvedValue([makeBatch({ startedAt: new Date(Date.now() - 10 * 60_000) })]),
      scheduleReconciliation: vi.fn(),
      completeBatch: vi.fn().mockResolvedValue(['99']),
    } as unknown as DeployRepository
    const remote = { status: vi.fn().mockResolvedValue({ state: 'absent', status: null, diagnostic: 'processo sumiu' }) } as never
    const consumer = new DeployConsumer(repository, {} as never, remote, logger, undefined, undefined, undefined, 5 * 60_000)

    await (consumer as unknown as { reconcile(m: QueueMessage): Promise<void> }).reconcile(reconcileMessage())

    expect(repository.scheduleReconciliation).not.toHaveBeenCalled()
    expect(repository.completeBatch).toHaveBeenCalledTimes(1)
    const [, success, reason] = repository.completeBatch.mock.calls[0]
    expect(success).toBe(false)
    expect(String(reason)).toContain('timeout')
  })

  it('receiveResult permanece inalterado: success fecha o batch sem tocar no reagendamento', async () => {
    const { logger } = captureLogger()
    const repository = {
      runningBatches: vi.fn(),
      scheduleReconciliation: vi.fn(),
      completeBatch: vi.fn().mockResolvedValue(['99']),
      repoPathForTask: vi.fn().mockResolvedValue(null),
      integrationBranchesAwaitingBaseSync: vi.fn().mockResolvedValue([]),
    } as unknown as DeployRepository
    const consumer = new DeployConsumer(repository, {} as never, {} as never, logger)

    await consumer.handle(createQueueMessage({ type: 'DEPLOY_BATCH_RESULT_RECEIVED', taskId: '99', executionId: 'e1', payload: { batchId: 'batch-reconcile-retry', status: 'success' } }))

    expect(repository.scheduleReconciliation).not.toHaveBeenCalled()
    expect(repository.completeBatch).toHaveBeenCalledWith('batch-reconcile-retry', true, null, expect.anything())
  })
})

/**
 * Fake do pool que emula o motor_outbox com as UNIQUE KEYS reais
 * (message_id e logical key (type, task_id, correlation_id)) — só assim os testes
 * provam que a dedup não engole a reemissão do segundo ciclo.
 */
function createOutboxFakePool(runningRows: Array<Record<string, unknown>> = []) {
  const rows: Array<Record<string, unknown>> = []
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO motor_outbox/i.test(sql)) {
        const [messageId, type, destinationQueue, taskId, executionId, payloadJson, correlationId, causationId] = params as unknown[]
        if (rows.some(r => r.message_id === messageId || (r.type === type && r.task_id === taskId && r.correlation_id === correlationId))) {
          return [{ affectedRows: 0, insertId: 0 }, []] // ON DUPLICATE KEY UPDATE message_id = message_id (no-op)
        }
        const deferMatch = sql.match(/DATE_ADD\(NOW\(\), INTERVAL (\d+) SECOND\)/)
        rows.push({ message_id: messageId, type, destination_queue: destinationQueue, task_id: taskId, execution_id: executionId, payload_json: payloadJson, correlation_id: correlationId, causation_id: causationId, deferSeconds: deferMatch ? Number(deferMatch[1]) : 0 })
        return [{ affectedRows: 1, insertId: rows.length }, []]
      }
      if (/FROM deploy_batches/i.test(sql)) return [runningRows, []]
      return [{ affectedRows: 1, insertId: 0 }, []]
    }),
  }
  const pool = {
    query: connection.query,
    getConnection: vi.fn().mockResolvedValue(connection),
  }
  return { pool, rows, connection }
}

function batchSelectRow(batchId: string): Record<string, unknown> {
  return { batch_id: batchId, repo_path: '/r', base_branch: 'base-desenvolvimento', expected_commit: 'c', status: 'running', remote_pid: '1', remote_status_path: '/tmp/x.status', started_at: new Date(), workspace_path: '/w', gate_job_id: 1, project_layout: null, repo_path_host: null, git_remote: null, deploy_kind: null, deploy_script: null }
}

describe('DeployRepository.enqueueReconciliationForRunning — correlation único por ciclo', () => {
  it('dois ciclos consecutivos para o mesmo batch geram correlation_id distintos e ambos sobrevivem à dedup', async () => {
    const { pool, rows } = createOutboxFakePool([batchSelectRow('b-unique')])
    const repo = new DeployRepository(pool as never, '/tmp/worktrees')

    const first = await repo.enqueueReconciliationForRunning(1000)
    await new Promise(resolve => setTimeout(resolve, 2))
    const second = await repo.enqueueReconciliationForRunning(1000)

    expect(first).toBe(1)
    expect(second).toBe(1)
    const reconciliations = rows.filter(r => r.type === 'DEPLOY_RECONCILIATION_REQUESTED')
    expect(reconciliations).toHaveLength(2) // sem unique por ciclo, o 2º INSERT seria engolido pela dedup
    const correlations = reconciliations.map(r => String(r.correlation_id))
    expect(new Set(correlations).size).toBe(2)
    expect(correlations.every(c => /^deploy-reconcile-cycle-b-unique-\d{13}$/.test(c))).toBe(true)
    const executions = reconciliations.map(r => String(r.execution_id))
    expect(new Set(executions).size).toBe(2)
    expect(executions.every(e => /^deploy-reconcile-b-unique-\d{13}$/.test(e))).toBe(true)
    // nasce adiada no outbox (DATE_ADD), não imediata
    expect(reconciliations.every(r => r.deferSeconds === 1)).toBe(true)
  })

  it('regressão: correlation fixo para o mesmo batch é engolido pela dedup do outbox (por isso é único por ciclo)', async () => {
    const { pool, rows } = createOutboxFakePool([batchSelectRow('b-dedup')])
    const repo = new DeployRepository(pool as never, '/tmp/worktrees')
    const source = reconcileMessage('b-dedup')
    void repo
    void source
    void rows
    // Reinserção manual com logical key idêntica simula o comportamento antigo:
    const insert = (correlationId: string) => pool.query(
      `INSERT INTO motor_outbox (message_id,type,destination_queue,task_id,execution_id,payload_json,timestamp,correlation_id,causation_id,status,attempt)
       VALUES (?,?,?,?,?,?,DATE_ADD(NOW(), INTERVAL 300 SECOND),?,?,'pending',0)
       ON DUPLICATE KEY UPDATE message_id = message_id`,
      [`mid-${correlationId}`, 'DEPLOY_RECONCILIATION_REQUESTED', 'motor.commands', 'system', `exec-${correlationId}`, '{}', correlationId, 'caus'],
    )
    await insert('fixo')
    const secondHeader = (await insert('fixo'))[0] as { affectedRows: number }
    expect(secondHeader.affectedRows).toBe(0) // dedup engoliu — evidência do defeito
  })

  it('scheduleReconciliation insere mensagem única, adiada, com causation da mensagem original', async () => {
    const { pool, rows } = createOutboxFakePool()
    const repo = new DeployRepository(pool as never, '/tmp/worktrees')
    const source = reconcileMessage('b-sched')

    const message = await repo.scheduleReconciliation(source, 'b-sched', 'deploy-reconcile-b-sched-1700000000000', 'deploy-reconcile-cycle-b-sched-1700000000000', 3000)

    expect(message.type).toBe('DEPLOY_RECONCILIATION_REQUESTED')
    expect(message.taskId).toBe('system')
    expect(message.correlationId).toBe('deploy-reconcile-cycle-b-sched-1700000000000')
    expect(message.causationId).toBe(source.messageId)
    const inserted = rows.find(r => r.message_id === message.messageId)
    expect(inserted).toBeDefined()
    expect(inserted?.deferSeconds).toBe(3)
    expect(inserted?.destination_queue).toBe('motor.commands')
  })

  it('scheduleReconciliation falha alto se o INSERT não for aceito (sem silently drop)', async () => {
    const { pool } = createOutboxFakePool()
    pool.query.mockResolvedValueOnce([{ affectedRows: 0, insertId: 0 }, []])
    const repo = new DeployRepository(pool as never, '/tmp/worktrees')

    await expect(repo.scheduleReconciliation(reconcileMessage(), 'b-x', 'exec-1', 'corr-1', 1000)).rejects.toThrow(/Reagendamento/)
  })

  it('markRemoteStarted emite reconciliation com correlation único por início de lote (não reutiliza o do source)', async () => {
    const { pool, rows } = createOutboxFakePool()
    const repo = new DeployRepository(pool as never, '/tmp/worktrees')
    const source = createQueueMessage({ type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', taskId: '77', executionId: 'dispatch-1', payload: { batchId: 'b-start' } })

    const reconcile = await repo.markRemoteStarted('b-start', '4321', '/tmp/biblioteca-global-b-start.status', source)

    expect(reconcile.executionId).toMatch(/^deploy-reconcile-b-start-\d{13}$/)
    expect(reconcile.correlationId).toMatch(/^deploy-reconcile-init-b-start-\d{13}$/)
    expect(reconcile.correlationId).not.toBe(source.correlationId ?? source.messageId)
    const saved = rows.find(r => r.type === 'DEPLOY_RECONCILIATION_REQUESTED')
    expect(saved?.correlation_id).toBe(reconcile.correlationId)
    expect(saved?.task_id).toBe('77')
  })
})
