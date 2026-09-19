import { describe, it, expect, vi } from 'vitest'
import { setFlag, log } from '../src/primitives/control.js'
import type { PrimitiveContext } from '../src/primitives/types.js'

describe('Control Primitives', () => {
  const mockContext: PrimitiveContext = {
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

  describe('set_flag', () => {
    it('should set flag with default value true', async () => {
      const result = await setFlag.handler(mockContext, { flag: 'retry' })
      
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ flag: 'retry', value: true })
      expect(mockContext.logger?.info).toHaveBeenCalledWith(
        '[set_flag] retry = true',
        { taskId: 'task-123', subtaskId: 456 }
      )
    })

    it('should set flag with custom value', async () => {
      const result = await setFlag.handler(mockContext, { flag: 'retry_count', value: 3 })
      
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ flag: 'retry_count', value: 3 })
    })

    it('should fail without flag parameter', async () => {
      const result = await setFlag.handler(mockContext, {})
      
      expect(result.success).toBe(false)
      expect(result.error).toBe('Parâmetro "flag" é obrigatório')
    })
  })

  describe('log', () => {
    it('should log info by default', async () => {
      const result = await log.handler(mockContext, { message: 'Test message' })
      
      expect(result.success).toBe(true)
      expect(mockContext.logger?.info).toHaveBeenCalledWith('Test message', {
        taskId: 'task-123',
        subtaskId: 456,
        executionId: 'exec-789',
        generation: 1,
      })
    })

    it('should log warn when specified', async () => {
      const result = await log.handler(mockContext, { level: 'warn', message: 'Warning message' })
      
      expect(result.success).toBe(true)
      expect(mockContext.logger?.warn).toHaveBeenCalledWith('Warning message', {
        taskId: 'task-123',
        subtaskId: 456,
        executionId: 'exec-789',
        generation: 1,
      })
    })

    it('should log error when specified', async () => {
      const result = await log.handler(mockContext, { level: 'error', message: 'Error message' })
      
      expect(result.success).toBe(true)
      expect(mockContext.logger?.error).toHaveBeenCalledWith('Error message', {
        taskId: 'task-123',
        subtaskId: 456,
        executionId: 'exec-789',
        generation: 1,
      })
    })

    it('should include extra data when provided', async () => {
      const result = await log.handler(mockContext, {
        message: 'Test with extra',
        extra: { customField: 'customValue' },
      })
      
      expect(result.success).toBe(true)
      expect(mockContext.logger?.info).toHaveBeenCalledWith('Test with extra', {
        taskId: 'task-123',
        subtaskId: 456,
        executionId: 'exec-789',
        generation: 1,
        customField: 'customValue',
      })
    })
  })
})
