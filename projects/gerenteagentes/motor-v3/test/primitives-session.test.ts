import { describe, it, expect, vi } from 'vitest'
import { createSession, parseReply, incrementGeneration } from '../src/primitives/session.js'
import type { PrimitiveContext } from '../src/primitives/types.js'

describe('Session Primitives', () => {
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

  describe('parseReply', () => {
    it('should detect ::DONE:: marker', async () => {
      const result = await parseReply.handler(mockContext, {
        response: 'Fiz as alterações solicitadas. ::DONE::',
      })
      
      expect(result.success).toBe(true)
      expect(result.data?.hasDoneMarker).toBe(true)
      expect(mockContext.logger?.info).toHaveBeenCalledWith(
        'Resposta parseada',
        expect.objectContaining({ hasDoneMarker: true })
      )
    })

    it('should detect ::done:: marker (case insensitive)', async () => {
      const result = await parseReply.handler(mockContext, {
        response: 'Finalizado ::done::',
      })
      
      expect(result.success).toBe(true)
      expect(result.data?.hasDoneMarker).toBe(true)
    })

    it('should return false when no marker present', async () => {
      const result = await parseReply.handler(mockContext, {
        response: 'Ainda estou trabalhando nisso.',
      })
      
      expect(result.success).toBe(true)
      expect(result.data?.hasDoneMarker).toBe(false)
    })

    it('should fail without response parameter', async () => {
      const result = await parseReply.handler(mockContext, {})
      
      expect(result.success).toBe(false)
      expect(result.error).toBe('Parâmetro "response" inválido')
    })

    it('should fail with non-string response', async () => {
      const result = await parseReply.handler(mockContext, { response: 123 })
      
      expect(result.success).toBe(false)
      expect(result.error).toBe('Parâmetro "response" inválido')
    })
  })

  describe('createSession', () => {
    it('usa namespace próprio para sessões do Monitor', async () => {
      const consoleApi = { createSession: vi.fn().mockResolvedValue({ sessionId: 'monitor-session' }) }
      const context = { ...mockContext, sessionKind: 'monitor' as const, monitorBlockerId: 456, consoleApi }

      const result = await createSession.handler(context)

      expect(result.success).toBe(true)
      expect(context.sessionKey).toBe('monitor-console-default-task-123-b456')
      expect(consoleApi.createSession).toHaveBeenCalledWith(expect.objectContaining({
        key: 'monitor-console-default-task-123-b456',
        metadata: expect.objectContaining({ sessionKind: 'monitor', monitorBlockerId: 456 }),
      }))
    })

    it('recusa sessão DEV sem subtaskId em vez de criar sundefined', async () => {
      const context = { ...mockContext, subtaskId: undefined, consoleApi: { createSession: vi.fn() } }

      const result = await createSession.handler(context)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Sessão DEV exige subtaskId')
      expect(context.consoleApi.createSession).not.toHaveBeenCalled()
    })
  })

  describe('incrementGeneration', () => {
    it('should increment generation counter', async () => {
      const context = { ...mockContext, generation: 1 }
      const result = await incrementGeneration.handler(context)
      
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ oldGeneration: 1, newGeneration: 2 })
      expect(context.generation).toBe(2)
      expect(mockContext.logger?.info).toHaveBeenCalledWith(
        'Geração incrementada',
        {
          taskId: 'task-123',
          subtaskId: 456,
          oldGeneration: 1,
          newGeneration: 2,
        }
      )
    })

    it('should increment from any value', async () => {
      const context = { ...mockContext, generation: 5 }
      const result = await incrementGeneration.handler(context)
      
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ oldGeneration: 5, newGeneration: 6 })
      expect(context.generation).toBe(6)
    })
  })
})
// @vitest-environment node
