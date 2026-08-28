/**
 * Testes do ResourceLeaseService
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import type { Db } from '@gerente-agentes/persistence'
import type { ResourceKey } from '../src/shared/types/resources.js'

describe('ResourceLeaseService', () => {
  let service: ResourceLeaseService
  let mockDb: Db

  beforeEach(() => {
    // Mock do Db
    mockDb = {
      query: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Db

    service = new ResourceLeaseService(mockDb, {
      leaseExpirationMs: 60000,
      maxWaitSeconds: 300,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('acquire', () => {
    it('deve adquirir recurso quando disponível', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey
      const executionId = 'exec-123'
      const ownerId = 'task-456'

      // Mock: recurso disponível
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 1,
        insertId: 0,
      })

      // Mock: getLease
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{
          resource_key: resourceKey,
          execution_id: executionId,
          owner_id: ownerId,
          fencing_token: 1,
          heartbeat_at: new Date().toISOString(),
          acquired_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60000).toISOString(),
        }],
        affectedRows: 0,
        insertId: 0,
      })

      const result = await service.acquire(resourceKey, executionId, ownerId)

      expect(result.kind).toBe('acquired')
      if (result.kind === 'acquired') {
        expect(result.lease.resourceKey).toBe(resourceKey)
        expect(result.lease.executionId).toBe(executionId)
        expect(result.lease.fencingToken).toBe(1)
      }
    })

    it('deve entrar na fila quando recurso está ocupado', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey
      const executionId = 'exec-123'
      const ownerId = 'task-456'

      // Mock: recurso ocupado (INSERT falha)
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 0,
        insertId: 0,
      })

      // Mock: enqueueWait - INSERT na fila
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 1,
        insertId: 42,
      })

      // Mock: enqueueWait - SELECT posição
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{ position: 2 }],
        affectedRows: 0,
        insertId: 0,
      })

      const result = await service.acquire(resourceKey, executionId, ownerId)

      expect(result.kind).toBe('waiting')
      if (result.kind === 'waiting') {
        expect(result.waitId).toBe(42)
        expect(result.position).toBe(2)
      }
    })

    it('deve retornar denied em caso de erro', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey
      const executionId = 'exec-123'
      const ownerId = 'task-456'

      vi.mocked(mockDb.query).mockRejectedValueOnce(new Error('Database error'))

      const result = await service.acquire(resourceKey, executionId, ownerId)

      expect(result.kind).toBe('denied')
      if (result.kind === 'denied') {
        expect(result.reason).toContain('Database error')
      }
    })
  })

  describe('renew', () => {
    it('deve renovar lease válido', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey
      const executionId = 'exec-123'
      const fencingToken = 1

      // Mock: UPDATE bem-sucedido
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 1,
        insertId: 0,
      })

      // Mock: getLease
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{
          resource_key: resourceKey,
          execution_id: executionId,
          owner_id: 'task-456',
          fencing_token: fencingToken,
          heartbeat_at: new Date().toISOString(),
          acquired_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60000).toISOString(),
        }],
        affectedRows: 0,
        insertId: 0,
      })

      const result = await service.renew(resourceKey, executionId, fencingToken)

      expect(result.kind).toBe('renewed')
    })

    it('deve retornar lost quando lease expirou', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey
      const executionId = 'exec-123'
      const fencingToken = 1

      // Mock: UPDATE não afeta nenhuma linha
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 0,
        insertId: 0,
      })

      const result = await service.renew(resourceKey, executionId, fencingToken)

      expect(result.kind).toBe('lost')
    })
  })

  describe('release', () => {
    it('deve liberar recurso', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey
      const executionId = 'exec-123'
      const fencingToken = 1

      // Mock: DELETE bem-sucedido
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 1,
        insertId: 0,
      })

      // Mock: notifyNextInQueue
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 1,
        insertId: 0,
      })

      const result = await service.release(resourceKey, executionId, fencingToken)

      expect(result.kind).toBe('released')
    })

    it('deve retornar not_owner quando não é o proprietário', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey
      const executionId = 'exec-123'
      const fencingToken = 1

      // Mock: DELETE não afeta nenhuma linha
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 0,
        insertId: 0,
      })

      const result = await service.release(resourceKey, executionId, fencingToken)

      expect(result.kind).toBe('not_owner')
    })
  })

  describe('isAvailable', () => {
    it('deve retornar true quando recurso está livre', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey

      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [],
        affectedRows: 0,
        insertId: 0,
      })

      const result = await service.isAvailable(resourceKey)

      expect(result).toBe(true)
    })

    it('deve retornar false quando recurso está ocupado', async () => {
      const resourceKey = 'project:test:execution' as ResourceKey

      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{ 1: 1 }],
        affectedRows: 0,
        insertId: 0,
      })

      const result = await service.isAvailable(resourceKey)

      expect(result).toBe(false)
    })
  })
})
