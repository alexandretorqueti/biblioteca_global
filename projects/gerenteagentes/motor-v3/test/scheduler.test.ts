import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Scheduler } from '../src/scheduler/Scheduler.js'
import type { MessageBus } from '../src/bus/index.js'
import type { PrimitiveContext } from '../src/primitives/types.js'

describe('Scheduler', () => {
  let scheduler: Scheduler
  let mockBus: MessageBus
  let mockContext: PrimitiveContext

  beforeEach(() => {
    vi.useFakeTimers()
    
    mockBus = {
      send: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      subscribe: vi.fn(),
      use: vi.fn(),
      debug: vi.fn().mockReturnValue({ typeHandlers: {}, topicHandlers: {} }),
      reset: vi.fn(),
    } as any

    scheduler = new Scheduler(mockBus, {
      executionTimeoutMs: 1000, // 1 segundo para testes
      silenceTimeoutMs: 500, // 500ms para testes
      heartbeatIntervalMs: 100, // 100ms para testes
      reconciliationIntervalMs: 200, // 200ms para testes
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

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  describe('registerExecution', () => {
    it('should register active execution', () => {
      scheduler.registerExecution(mockContext)
      
      const executions = scheduler.getActiveExecutions()
      expect(executions).toHaveLength(1)
      expect(executions[0].executionId).toBe('exec-789')
    })
  })

  describe('unregisterExecution', () => {
    it('should remove active execution', () => {
      scheduler.registerExecution(mockContext)
      scheduler.unregisterExecution('exec-789')
      
      const executions = scheduler.getActiveExecutions()
      expect(executions).toHaveLength(0)
    })
  })

  describe('heartbeat', () => {
    it('should update lastHeartbeat timestamp', () => {
      scheduler.registerExecution(mockContext)
      
      vi.advanceTimersByTime(100)
      scheduler.heartbeat('exec-789')
      
      const executions = scheduler.getActiveExecutions()
      expect(executions[0].lastHeartbeat).toBeGreaterThan(executions[0].startedAt)
    })
  })

  describe('reconcile', () => {
    it('should emit EXECUTION_TIMEOUT when execution exceeds timeout', async () => {
      scheduler.registerExecution(mockContext)
      scheduler.start()

      // Faz heartbeat periódico para evitar SILENCE_TIMEOUT
      const heartbeatInterval = setInterval(() => {
        scheduler.heartbeat('exec-789')
      }, 100)

      // Avança tempo além do executionTimeoutMs (1000ms)
      await vi.advanceTimersByTimeAsync(1200)
      
      clearInterval(heartbeatInterval)

      expect(mockBus.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EXECUTION_TIMEOUT',
          taskId: 'task-123',
          subtaskId: 456,
          executionId: 'exec-789',
        })
      )

      // Execução deve ser removida após timeout
      const executions = scheduler.getActiveExecutions()
      expect(executions).toHaveLength(0)
    })

    it('should emit SILENCE_TIMEOUT when heartbeat is missing', async () => {
      scheduler.registerExecution(mockContext)
      scheduler.start()

      // Avança tempo além do silenceTimeoutMs (500ms) sem heartbeat
      vi.advanceTimersByTime(600)

      expect(mockBus.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SILENCE_TIMEOUT',
          taskId: 'task-123',
        })
      )
    })

    it('should not timeout when heartbeat is active', async () => {
      scheduler.registerExecution(mockContext)
      scheduler.start()

      // Avança 400ms e faz heartbeat
      vi.advanceTimersByTime(400)
      scheduler.heartbeat('exec-789')

      // Avança mais 400ms (total 800ms, mas último heartbeat foi há 400ms)
      vi.advanceTimersByTime(400)

      // Não deve ter emitido SILENCE_TIMEOUT (último heartbeat foi há 400ms, dentro do timeout de 500ms)
      const silenceCalls = (mockBus.send as any).mock.calls.filter(
        (call: any[]) => call[0].type === 'SILENCE_TIMEOUT'
      )
      expect(silenceCalls).toHaveLength(0)
    })
  })

  describe('checkHeartbeats', () => {
    it('should emit HEARTBEAT_MISSING when heartbeat is delayed', async () => {
      scheduler.registerExecution(mockContext)
      scheduler.start()

      // Avança tempo além do silenceTimeoutMs (500ms)
      vi.advanceTimersByTime(600)

      expect(mockBus.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'HEARTBEAT_MISSING',
          taskId: 'task-123',
        })
      )
    })
  })

  describe('stop', () => {
    it('should clear all timers', () => {
      scheduler.start()
      scheduler.stop()

      // Não deve emitir eventos após stop
      vi.advanceTimersByTime(2000)
      expect(mockBus.send).not.toHaveBeenCalled()
    })
  })
})
