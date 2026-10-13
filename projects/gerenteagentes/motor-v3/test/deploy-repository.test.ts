// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeployRepository } from '../src/deploy/DeployRepository.js'
import { buildRetryExecutionId, stripRetrySuffixes, EXECUTION_ID_MAX_LENGTH } from '../src/deploy/retryExecutionId.js'
import { createQueueMessage, type QueueMessage } from '../src/queue/QueueMessage.js'

/**
 * Testes unitários dos métodos de lock de deploy do DeployRepository:
 * - acquireDeployLock(batchId, reason)
 * - releaseDeployLock()
 * - isDeployLocked()
 * - waitForActiveExecutionsToComplete(timeoutMs)
 *
 * Mock do pool MySQL: simula query/getConnection com comportamento transacional.
 */

function createMockConnection(overrides: Record<string, unknown> = {}) {
  return {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn().mockResolvedValue([[], []]),
    ...overrides,
  }
}

function createMockPool(connectionOverrides: Record<string, unknown> = {}) {
  const connection = createMockConnection(connectionOverrides)
  return {
    query: vi.fn().mockResolvedValue([[], []]),
    getConnection: vi.fn().mockResolvedValue(connection),
    _connection: connection,
  }
}

describe('DeployRepository — deploy lock', () => {
  describe('acquireDeployLock', () => {
    it('adquire o lock quando tabela está vazia (INSERT ON DUPLICATE KEY UPDATE)', async () => {
      const connection = createMockConnection()
      // Primeira query (SELECT FOR UPDATE): retorna linha com locked=0
      connection.query
        .mockResolvedValueOnce([[{ locked: 0, locked_by: null }], []]) // SELECT FOR UPDATE
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]) // INSERT/UPDATE
      const pool = createMockPool()
      pool.getConnection.mockResolvedValue(connection)
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const result = await repo.acquireDeployLock('deploy-abc', 'Deploy tarefa 123')

      expect(result).toBe(true)
      expect(connection.beginTransaction).toHaveBeenCalled()
      expect(connection.commit).toHaveBeenCalled()
      expect(connection.query).toHaveBeenCalledTimes(2)
      // Verifica que o INSERT foi chamado com os parâmetros corretos
      const insertCall = connection.query.mock.calls[1]
      expect(insertCall[0]).toContain('INSERT INTO motor_deploy_lock')
      expect(insertCall[1]).toEqual(['deploy-abc', 'Deploy tarefa 123'])
    })

    it('retorna false quando lock já está ativo por outro batchId', async () => {
      const connection = createMockConnection()
      // SELECT FOR UPDATE retorna locked=1 por outro batch
      connection.query.mockResolvedValueOnce([[{ locked: 1, locked_by: 'deploy-other' }], []])
      const pool = createMockPool()
      pool.getConnection.mockResolvedValue(connection)
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const result = await repo.acquireDeployLock('deploy-new', 'Tentativa de outro deploy')

      expect(result).toBe(false)
      expect(connection.beginTransaction).toHaveBeenCalled()
      expect(connection.commit).toHaveBeenCalled()
      // Apenas o SELECT foi executado (não fez INSERT)
      expect(connection.query).toHaveBeenCalledTimes(1)
    })

    it('re-adquire quando mesmo batchId já tem o lock (idempotente)', async () => {
      const connection = createMockConnection()
      // SELECT FOR UPDATE retorna locked=1 pelo mesmo batch
      connection.query
        .mockResolvedValueOnce([[{ locked: 1, locked_by: 'deploy-abc' }], []]) // SELECT FOR UPDATE
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]) // INSERT/UPDATE
      const pool = createMockPool()
      pool.getConnection.mockResolvedValue(connection)
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const result = await repo.acquireDeployLock('deploy-abc', 'Retry do mesmo deploy')

      expect(result).toBe(true)
      expect(connection.query).toHaveBeenCalledTimes(2)
    })

    it('faz rollback em caso de erro e propaga exceção', async () => {
      const connection = createMockConnection()
      connection.query.mockRejectedValueOnce(new Error('DB connection lost'))
      const pool = createMockPool()
      pool.getConnection.mockResolvedValue(connection)
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      await expect(repo.acquireDeployLock('deploy-abc', 'reason')).rejects.toThrow('DB connection lost')
      expect(connection.rollback).toHaveBeenCalled()
      expect(connection.release).toHaveBeenCalled()
    })

    it('trunca reason em 500 caracteres', async () => {
      const connection = createMockConnection()
      connection.query
        .mockResolvedValueOnce([[{ locked: 0, locked_by: null }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      const pool = createMockPool()
      pool.getConnection.mockResolvedValue(connection)
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const longReason = 'x'.repeat(600)
      await repo.acquireDeployLock('deploy-abc', longReason)

      const insertCall = connection.query.mock.calls[1]
      expect(insertCall[1][1]).toHaveLength(500)
    })
  })

  describe('releaseDeployLock', () => {
    it('atualiza locked=false e limpa metadados', async () => {
      const pool = createMockPool()
      pool.query.mockResolvedValue([{ affectedRows: 1 }, []])
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      await repo.releaseDeployLock()

      expect(pool.query).toHaveBeenCalledTimes(1)
      const call = pool.query.mock.calls[0]
      expect(call[0]).toContain('UPDATE motor_deploy_lock')
      expect(call[0]).toContain('locked = FALSE')
      expect(call[0]).toContain('locked_at = NULL')
      expect(call[0]).toContain('locked_by = NULL')
      expect(call[0]).toContain('reason = NULL')
    })

    it('é idempotente: não falha se lock já está liberado', async () => {
      const pool = createMockPool()
      pool.query.mockResolvedValue([{ affectedRows: 0 }, []]) // Nenhuma linha atualizada
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      await expect(repo.releaseDeployLock()).resolves.toBeUndefined()
    })
  })

  describe('isDeployLocked', () => {
    it('retorna true quando locked=1', async () => {
      const pool = createMockPool()
      pool.query.mockResolvedValue([[{ locked: 1 }], []])
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const result = await repo.isDeployLocked()

      expect(result).toBe(true)
    })

    it('retorna false quando locked=0', async () => {
      const pool = createMockPool()
      pool.query.mockResolvedValue([[{ locked: 0 }], []])
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const result = await repo.isDeployLocked()

      expect(result).toBe(false)
    })

    it('retorna false quando tabela está vazia (sem linha singleton)', async () => {
      const pool = createMockPool()
      pool.query.mockResolvedValue([[], []]) // Nenhuma linha
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const result = await repo.isDeployLocked()

      expect(result).toBe(false)
    })

    it('trata locked como string (MySQL pode retornar "0"/"1")', async () => {
      const pool = createMockPool()
      pool.query.mockResolvedValue([[{ locked: '1' }], []])
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const result = await repo.isDeployLocked()

      expect(result).toBe(true)
    })
  })

  describe('waitForActiveExecutionsToComplete', () => {
    it('retorna completed=true imediatamente quando motor já está ocioso', async () => {
      const pool = createMockPool()
      // isMotorIdle retorna true (active=0)
      pool.query.mockResolvedValue([[{ active: 0 }], []])
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const result = await repo.waitForActiveExecutionsToComplete(60000)

      expect(result).toEqual({ completed: true, forced: false })
      expect(pool.query).toHaveBeenCalledTimes(1) // Apenas uma chamada a isMotorIdle
    })

    it('aguarda e retorna completed=true quando motor fica ocioso antes do timeout', async () => {
      vi.useFakeTimers()
      const pool = createMockPool()
      // Primeira chamada: motor ocupado (active=1)
      // Segunda chamada: motor ocioso (active=0)
      pool.query
        .mockResolvedValueOnce([[{ active: 1 }], []]) // isMotorIdle → false
        .mockResolvedValueOnce([[{ active: 0 }], []]) // isMotorIdle → true (após 5s)
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const promise = repo.waitForActiveExecutionsToComplete(60000)

      // Avança 5 segundos para o primeiro poll
      await vi.advanceTimersByTimeAsync(5000)

      const result = await promise
      expect(result).toEqual({ completed: true, forced: false })
      expect(pool.query).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it('retorna completed=false, forced=true quando timeout expira', async () => {
      vi.useFakeTimers()
      const pool = createMockPool()
      // Motor sempre ocupado
      pool.query.mockResolvedValue([[{ active: 1 }], []])
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const promise = repo.waitForActiveExecutionsToComplete(8000) // 8s timeout

      // Avança 5s (primeiro poll: ocupado)
      await vi.advanceTimersByTimeAsync(5000)
      // Avança mais 3s (total 8s: timeout atingido)
      await vi.advanceTimersByTimeAsync(3000)

      const result = await promise
      expect(result).toEqual({ completed: false, forced: true })

      vi.useRealTimers()
    })

    it('poll em intervalos de 5s até timeout', async () => {
      vi.useFakeTimers()
      const pool = createMockPool()
      // Motor ocupado nas primeiras 3 chamadas, ocioso na 4ª
      pool.query
        .mockResolvedValueOnce([[{ active: 1 }], []]) // 0s
        .mockResolvedValueOnce([[{ active: 1 }], []]) // 5s
        .mockResolvedValueOnce([[{ active: 1 }], []]) // 10s
        .mockResolvedValueOnce([[{ active: 0 }], []]) // 15s
      const repo = new DeployRepository(pool as never, '/tmp/worktrees')

      const promise = repo.waitForActiveExecutionsToComplete(60000)

      // Avança 15s (3 polls de 5s)
      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(5000)

      const result = await promise
      expect(result).toEqual({ completed: true, forced: false })
      expect(pool.query).toHaveBeenCalledTimes(4)

      vi.useRealTimers()
    })
  })
})

describe('DeployRepository — composição do lote', () => {
  it('reúne commits pendentes compatíveis do mesmo repositório e branch', async () => {
    const connection = createMockConnection()
    connection.query
      .mockResolvedValueOnce([[{ total: 0 }], []]) // nenhum lote ativo
      .mockResolvedValueOnce([[{
        build_command: 'npm run build', test_command: 'npm test',
      }], []])
      .mockResolvedValueOnce([[{
        id: 10, task_id: 902, external_id: 'task-p2-902', requested_commit: 'commit-902',
        project_id: 1, build_command: 'npm run build', test_command: 'npm test',
      }, {
        id: 11, task_id: 903, external_id: 'task-p2-903', requested_commit: 'commit-903',
        project_id: 1, build_command: 'npm run build', test_command: 'npm test',
      }], []])
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
    const pool = createMockPool()
    pool.query.mockResolvedValue([[{ active: 0 }], []])
    pool.getConnection.mockResolvedValue(connection)
    const repo = new DeployRepository(pool as never, '/tmp/worktrees')

    const result = await repo.claimBatch({ payload: {
      repository: '/repo', baseBranch: 'base-desenvolvimento', expectedCommit: 'commit-902',
    }} as never)

    expect(result?.members.map(member => member.requestedCommit)).toEqual(['commit-902', 'commit-903'])
    const compatibleRequestsQuery = connection.query.mock.calls[2]
    expect(compatibleRequestsQuery[0]).toContain('pmc.build_command=?')
    expect(compatibleRequestsQuery[0]).toContain('pmc.unit_test_command=?')
    expect(compatibleRequestsQuery[1]).toEqual(['/repo', 'base-desenvolvimento', 'npm run build', 'npm test'])
  })
})

/**
 * Testes do execution_id de retry limitado (tarefa task-p2-999):
 * o reenfileiramento por deploy_lock/deploy_in_progress/analysis_capacity_waiting
 * não pode acumular sufixos nem ultrapassar varchar(200) de motor_outbox.execution_id.
 */
describe('retryExecutionId — utilitário compartilhado', () => {
  it('remove sufixo -deploy-retry-<timestamp> anterior antes de anexar o novo', () => {
    const result = buildRetryExecutionId('exec-orig-deploy-retry-111', 'deploy-retry', 222)
    expect(result).toBe('exec-orig-deploy-retry-222')
  })

  it('remove sufixo -retry-<timestamp> anterior antes de anexar o novo', () => {
    const result = buildRetryExecutionId('exec-orig-retry-111', 'retry', 222)
    expect(result).toBe('exec-orig-retry-222')
  })

  it('remove múltiplos sufixos acumulados de cadeias legadas (sem acúmulo)', () => {
    const legacy = `base${'-deploy-retry-1'.repeat(50)}`
    const result = buildRetryExecutionId(legacy, 'deploy-retry', 999)
    expect(result).toBe('base-deploy-retry-999')
    expect(result).not.toContain('-deploy-retry-999-deploy-retry')
    expect(stripRetrySuffixes(legacy)).toBe('base')
  })

  it('não altera execution_id sem sufixo de retry', () => {
    expect(stripRetrySuffixes('deploy-dispatch-recovery-123')).toBe('deploy-dispatch-recovery-123')
  })

  it('trunca a base quando necessário e garante resultado ≤ 200 caracteres', () => {
    const longBase = 'x'.repeat(300)
    const result = buildRetryExecutionId(longBase, 'deploy-retry', 1760000000000)
    expect(result.length).toBeLessThanOrEqual(EXECUTION_ID_MAX_LENGTH)
    expect(result.endsWith('-deploy-retry-1760000000000')).toBe(true)
  })

  it('mantém o componente variável (timestamp) no sufixo', () => {
    const a = buildRetryExecutionId('exec', 'deploy-retry', 1000)
    const b = buildRetryExecutionId('exec', 'deploy-retry', 2000)
    expect(a).not.toBe(b)
  })
})

describe('DeployRepository — execution_id de retry limitado no reenfileiramento', () => {
  /** Captura os parâmetros do INSERT em motor_outbox emitido pelo repositório. */
  function createRequeueMocks() {
    const connection = createMockConnection()
    const pool = createMockPool()
    pool.getConnection.mockResolvedValue(connection)
    const repo = new DeployRepository(pool as never, '/tmp/worktrees')
    return { repo, connection }
  }

  /** Extrai o execution_id (5º parâmetro) do INSERT capturado no outbox. */
  function capturedOutboxInsert(connection: ReturnType<typeof createMockConnection>) {
    const call = connection.query.mock.calls[connection.query.mock.calls.length - 1]
    const sql = String(call[0])
    const params = call[1] as unknown[]
    return { sql, messageId: String(params[0]), type: String(params[1]), taskId: String(params[3]), executionId: String(params[4]), payload: JSON.parse(String(params[5])), correlationId: params[6] as string | null, causationId: params[7] as string | null }
  }

  it('requeueForDeployRetry: 120 ciclos encadeados nunca ultrapassam 200 caracteres e não acumulam sufixos', async () => {
    vi.useFakeTimers()
    try {
      const { repo, connection } = createRequeueMocks()
      const cycles = 120
      let executionId = `deploy-dispatch-${'y'.repeat(180)}` // base longa proposital
      let currentMessage: QueueMessage = createQueueMessage({ type: 'DEPLOY_REQUESTED', taskId: 'task-p2-999', executionId, payload: { original: 'value' } })
      const seenExecutionIds = new Set<string>()
      const seenMessageIds = new Set<string>()

      for (let i = 0; i < cycles; i++) {
        vi.setSystemTime(new Date(1760000000000 + i * 1000)) // timestamp variável por retry
        connection.query.mockClear()
        await repo.requeueForDeployRetry(currentMessage, 'deploy_in_progress')
        expect(connection.query).toHaveBeenCalledTimes(1) // exatamente um INSERT de outbox por retry
        const inserted = capturedOutboxInsert(connection)

        expect(inserted.executionId.length).toBeLessThanOrEqual(EXECUTION_ID_MAX_LENGTH)
        expect(inserted.executionId).toMatch(/-deploy-retry-\d+$/)
        // sem acúmulo: exatamente um marcador de retry no resultado
        expect(inserted.executionId.match(/-deploy-retry-/g)?.length).toBe(1)
        expect(inserted.executionId.match(/(?:-deploy)?-retry-/g)?.length).toBe(1)
        // publicação atrasada preservada
        expect(inserted.sql).toContain('DATE_ADD(NOW(), INTERVAL 30 SECOND)')
        // rastreabilidade e identidade
        seenExecutionIds.add(inserted.executionId)
        seenMessageIds.add(inserted.messageId)
        expect(inserted.correlationId).toBe(currentMessage.correlationId ?? currentMessage.messageId)
        expect(inserted.causationId).toBe(currentMessage.messageId)
        expect(inserted.type).toBe(currentMessage.type)
        expect(inserted.taskId).toBe(currentMessage.taskId)
        expect(inserted.payload.retryAfter).toBe('30s')
        expect(inserted.payload.deferredReason).toBe('deploy_in_progress')
        expect(inserted.payload.original).toBe('value')

        // saída deste retry vira a origem do próximo (simula a fila)
        currentMessage = createQueueMessage({
          type: inserted.type, taskId: inserted.taskId, executionId: inserted.executionId,
          correlationId: inserted.correlationId ?? undefined, causationId: inserted.causationId ?? undefined,
          payload: inserted.payload,
        })
      }

      expect(seenMessageIds.size).toBe(cycles)
      // messageId continua único por retry (randomUUID)
      // sufixo variável a cada retry → execution_ids distintos
      expect(seenExecutionIds.size).toBe(cycles)
      // sem ER_DATA_TOO_LONG: nenhum valor excede a coluna varchar(200)
      const finalId = currentMessage.executionId
      expect(finalId.length).toBeLessThanOrEqual(EXECUTION_ID_MAX_LENGTH)
    } finally {
      vi.useRealTimers()
    }
  })

  it('requeueForDeployRetry: remove o sufixo anterior e preserva correlation_id/causation_id da origem', async () => {
    const { repo, connection } = createRequeueMocks()
    const source = createQueueMessage({
      type: 'TASK_READY', taskId: 'task-p2-999', executionId: 'exec-base-deploy-retry-1111',
      correlationId: 'corr-original', causationId: 'cause-original', payload: { keep: 1 },
    })

    await repo.requeueForDeployRetry(source, 'analysis_capacity_waiting')

    const inserted = capturedOutboxInsert(connection)
    expect(inserted.executionId).toMatch(/^exec-base-deploy-retry-\d+$/)
    expect(inserted.executionId).not.toContain('1111-deploy-retry')
    expect(inserted.executionId.match(/-deploy-retry-/g)?.length).toBe(1)
    expect(inserted.correlationId).toBe('corr-original')
    expect(inserted.causationId).toBe(source.messageId)
    expect(inserted.payload).toEqual({ keep: 1, deferredReason: 'analysis_capacity_waiting', retryAfter: '30s' })
    expect(inserted.type).toBe('TASK_READY')
    expect(inserted.taskId).toBe('task-p2-999')
  })

  it('requeueForDeployRetry: usa messageId da origem como correlation_id quando ausente', async () => {
    const { repo, connection } = createRequeueMocks()
    const source = createQueueMessage({ type: 'DEPLOY_REQUESTED', taskId: 'task-x', executionId: 'exec-no-corr', payload: {} })

    await repo.requeueForDeployRetry(source, 'deploy_in_progress')

    const inserted = capturedOutboxInsert(connection)
    expect(inserted.correlationId).toBe(source.messageId)
    expect(inserted.causationId).toBe(source.messageId)
  })

  it('requeueDispatch: retries encadeados mantêm ≤200 caracteres, sem acúmulo e com correlação preservada', async () => {
    vi.useFakeTimers()
    try {
      const { repo, connection } = createRequeueMocks()
      const cycles = 110
      let currentMessage: QueueMessage = createQueueMessage({ type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', taskId: 'task-p2-999', executionId: `dispatch-${'z'.repeat(190)}`, payload: { repository: '/repo' } })

      for (let i = 0; i < cycles; i++) {
        vi.setSystemTime(new Date(1760000000000 + i * 1000))
        connection.query.mockClear()
        await repo.requeueDispatch(currentMessage, 'dispatch_deferred')
        expect(connection.query).toHaveBeenCalledTimes(1) // exatamente um INSERT de outbox por retry
        const inserted = capturedOutboxInsert(connection)

        expect(inserted.executionId.length).toBeLessThanOrEqual(EXECUTION_ID_MAX_LENGTH)
        expect(inserted.executionId.match(/(?:-deploy)?-retry-/g)?.length).toBe(1)
        expect(inserted.executionId).toMatch(/-retry-\d+$/)
        expect(inserted.correlationId).toBe(currentMessage.correlationId ?? currentMessage.messageId)
        expect(inserted.causationId).toBe(currentMessage.messageId)
        expect(inserted.type).toBe('DEPLOY_BATCH_DISPATCH_REQUESTED')
        expect(inserted.payload.deferredReason).toBe('dispatch_deferred')
        expect(inserted.payload.repository).toBe('/repo')

        currentMessage = createQueueMessage({
          type: inserted.type, taskId: inserted.taskId, executionId: inserted.executionId,
          correlationId: inserted.correlationId ?? undefined, causationId: inserted.causationId ?? undefined,
          payload: inserted.payload,
        })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('requeueDispatch: remove sufixo -retry-<ts> anterior antes de anexar o novo', async () => {
    const { repo, connection } = createRequeueMocks()
    const source = createQueueMessage({ type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', taskId: 'task-y', executionId: 'dispatch-base-retry-2222', correlationId: 'corr-disp', payload: {} })

    await repo.requeueDispatch(source, 'another_dispatch_active')

    const inserted = capturedOutboxInsert(connection)
    expect(inserted.executionId).toMatch(/^dispatch-base-retry-\d+$/)
    expect(inserted.executionId).not.toContain('2222-retry')
    expect(inserted.correlationId).toBe('corr-disp')
    expect(inserted.causationId).toBe(source.messageId)
  })
})
