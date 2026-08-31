/**
 * Testes do ResourceLeaseService
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import type { Db, QueryResult } from '../src/shared/types/infrastructure.js'
import type { ResourceKey } from '../src/shared/types/resources.js'

function createMockDb(): Db {
  const db: Db = {
    query: vi.fn().mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn(db)),
  }
  return db
}

describe('ResourceLeaseService', () => {
  let db: Db
  let service: ResourceLeaseService
  const resourceKey: ResourceKey = 'project:test:execution'
  const executionId = 'exec-123'
  const ownerId = 'task-456'

  beforeEach(() => {
    db = createMockDb()
    service = new ResourceLeaseService({ db })
  })

  describe('acquire', () => {
    it('deve adquirir recurso quando disponível', async () => {
      // db.query dentro da transaction retorna rows vazio (recurso livre)
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
      // INSERT retorna insertId
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 1 })

      const result = await service.acquire(resourceKey, executionId, ownerId)

      expect(result.kind).toBe('acquired')
      if (result.kind === 'acquired') {
        expect(result.lease.resourceKey).toBe(resourceKey)
        expect(result.lease.executionId).toBe(executionId)
        expect(result.lease.fencingToken).toBe(1)
      }
    })

    it('deve entrar na fila quando recurso está ocupado', async () => {
      const futureDate = new Date(Date.now() + 60000)
      // Recurso ocupado
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ resource_key: resourceKey, execution_id: 'other-exec', fencing_token: 5, expires_at: futureDate.toISOString() }],
        affectedRows: 0,
        insertId: 0,
      })
      // INSERT na fila
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 42 })
      // COUNT da fila
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ position: 2 }], affectedRows: 0, insertId: 0 })

      const result = await service.acquire(resourceKey, executionId, ownerId)

      expect(result.kind).toBe('waiting')
      if (result.kind === 'waiting') {
        expect(result.waitId).toBe(42)
        expect(result.position).toBe(2)
      }
    })

    it('deve retornar denied em caso de erro', async () => {
      vi.mocked(db.transaction).mockRejectedValueOnce(new Error('Database error'))

      const result = await service.acquire(resourceKey, executionId, ownerId)

      expect(result.kind).toBe('denied')
      if (result.kind === 'denied') {
        expect(result.reason).toContain('Database error')
      }
    })
  })

  describe('renew', () => {
    it('deve renovar lease válido', async () => {
      // UPDATE bem-sucedido
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
      // SELECT para retornar dados
      vi.mocked(db.query).mockResolvedValueOnce({
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

      const result = await service.renew(resourceKey, executionId, 1)
      expect(result.kind).toBe('renewed')
    })

    it('deve retornar lost quando lease expirou', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })

      const result = await service.renew(resourceKey, executionId, 1)
      expect(result.kind).toBe('lost')
    })
  })

  describe('release', () => {
    it('deve liberar recurso', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

      const result = await service.release(resourceKey, executionId, 1)
      expect(result.kind).toBe('released')
    })

    it('deve retornar not_found quando não existe', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })

      const result = await service.release(resourceKey, executionId, 1)
      expect(result.kind).toBe('not_found')
    })
  })

  describe('isAvailable', () => {
    it('deve retornar true quando recurso está livre', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })

      const result = await service.isAvailable(resourceKey)
      expect(result).toBe(true)
    })

    it('deve retornar false quando recurso está ocupado', async () => {
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ expires_at: new Date(Date.now() + 60000).toISOString() }],
        affectedRows: 0,
        insertId: 0,
      })

      const result = await service.isAvailable(resourceKey)
      expect(result).toBe(false)
    })
  })
})
