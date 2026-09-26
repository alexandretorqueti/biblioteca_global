import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeployRepository } from '../src/deploy/DeployRepository.js'

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
