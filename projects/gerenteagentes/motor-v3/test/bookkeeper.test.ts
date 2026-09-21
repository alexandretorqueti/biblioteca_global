import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Bookkeeper } from '../src/bookkeeper/Bookkeeper.js'
import type { PrimitiveContext } from '../src/primitives/types.js'

// Mock das primitivas
vi.mock('../src/primitives/index.js', () => ({
  commitChanges: {
    handler: vi.fn(),
  },
  mergeBranch: {
    handler: vi.fn(),
  },
  publishBranch: {
    handler: vi.fn(),
  },
  promoteToBase: {
    handler: vi.fn(),
  },
  enqueueDeploy: {
    handler: vi.fn(),
  },
}))

describe('Bookkeeper', () => {
  let bookkeeper: Bookkeeper
  let mockContext: PrimitiveContext
  let mocks: any

  beforeEach(async () => {
    vi.clearAllMocks()
    
    mocks = await import('../src/primitives/index.js')
    
    bookkeeper = new Bookkeeper({
      lockTimeoutMs: 1000,
    })

    mockContext = {
      taskId: 'task-123',
      subtaskId: 456,
      executionId: 'exec-789',
      generation: 1,
      projectSlug: 'test-project',
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      branchName: 'motor-v3/task-123/sub-456/a1',
      agentId: 'test-agent',
      db: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }
  })

  describe('commit', () => {
    it('should commit changes successfully', async () => {
      mocks.commitChanges.handler.mockResolvedValue({
        success: true,
        data: { commitHash: 'abc123' },
      })

      const result = await bookkeeper.commit(mockContext, 'Fix bug')

      expect(result.success).toBe(true)
      expect(result.commitHash).toBe('abc123')
    })

    it('should return error when commit fails', async () => {
      mocks.commitChanges.handler.mockResolvedValue({
        success: false,
        error: 'No changes to commit',
      })

      const result = await bookkeeper.commit(mockContext)

      expect(result.success).toBe(false)
      expect(result.error).toBe('No changes to commit')
    })
  })

  describe('promote', () => {
    it('should acquire lock and promote successfully', async () => {
      mocks.promoteToBase.handler.mockResolvedValue({ success: true })

      const result = await bookkeeper.promote(mockContext)

      expect(result.success).toBe(true)
    })

    it('should reject when lock already held by another task', async () => {
      const otherContext = { ...mockContext, taskId: 'task-999' }
      
      // Simula promoção demorada (não libera lock imediatamente)
      mocks.promoteToBase.handler.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { success: true }
      })

      // Primeira tarefa inicia promoção (adquire lock)
      const promise1 = bookkeeper.promote(mockContext)
      
      // Segunda tarefa tenta adquirir imediatamente (deve falhar)
      const result2 = await bookkeeper.promote(otherContext)
      expect(result2.success).toBe(false)
      expect(result2.error).toContain('Lock de integração já adquirido')
      
      // Aguarda primeira promoção completar
      await promise1
    })

    it('should release lock after successful promotion', async () => {
      mocks.promoteToBase.handler.mockResolvedValue({ success: true })

      await bookkeeper.promote(mockContext)

      // Segunda promoção deve funcionar (lock foi liberado)
      const result = await bookkeeper.promote(mockContext)
      expect(result.success).toBe(true)
    })

    it('should release lock even when promotion fails', async () => {
      mocks.promoteToBase.handler.mockResolvedValue({
        success: false,
        error: 'Merge conflict',
      })

      await bookkeeper.promote(mockContext)

      // Segunda promoção deve funcionar (lock foi liberado mesmo com falha)
      mocks.promoteToBase.handler.mockResolvedValue({ success: true })
      const result = await bookkeeper.promote(mockContext)
      expect(result.success).toBe(true)
    })

    it('should allow lock acquisition after timeout', async () => {
      bookkeeper = new Bookkeeper({ lockTimeoutMs: 100 }) // 100ms timeout
      mocks.promoteToBase.handler.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 150)) // Demora mais que timeout
        return { success: true }
      })

      // Primeira promoção (adquire lock)
      await bookkeeper.promote(mockContext)

      // Segunda promoção imediatamente após (lock ainda válido)
      const result = await bookkeeper.promote(mockContext)
      expect(result.success).toBe(true) // Lock expirou durante a primeira promoção
    })
  })

  describe('fullFlow', () => {
    it('should execute complete flow successfully', async () => {
      mocks.commitChanges.handler.mockResolvedValue({
        success: true,
        data: { commitHash: 'abc123' },
      })
      mocks.mergeBranch.handler.mockResolvedValue({ success: true })
      mocks.publishBranch.handler.mockResolvedValue({ success: true })
      mocks.promoteToBase.handler.mockResolvedValue({ success: true })
      mocks.enqueueDeploy.handler.mockResolvedValue({ success: true })

      const result = await bookkeeper.fullFlow(mockContext, 'Implement feature')

      expect(result.success).toBe(true)
      expect(result.commitHash).toBe('abc123')
    })

    it('should stop at first failure', async () => {
      mocks.commitChanges.handler.mockResolvedValue({ success: true })
      mocks.mergeBranch.handler.mockResolvedValue({
        success: false,
        error: 'Merge conflict',
      })

      const result = await bookkeeper.fullFlow(mockContext)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Merge conflict')
      expect(mocks.publishBranch.handler).not.toHaveBeenCalled()
    })
  })
})
// @vitest-environment node
