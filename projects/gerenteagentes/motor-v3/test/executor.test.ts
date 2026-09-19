import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ActionExecutor, type PrimitiveHandler } from '../src/executor/ActionExecutor.js'
import type { CatalogLoader, CatalogAction } from '../src/catalog/CatalogLoader.js'
import type { MotorContext } from '../src/shared/context.js'

// Mock CatalogLoader
const createMockCatalogLoader = (actions: CatalogAction[]): CatalogLoader => ({
  load: vi.fn().mockResolvedValue({ events: [], patterns: [], actions, reactions: [], loadedAt: new Date() }),
  reload: vi.fn(),
  getEventByCode: vi.fn(),
  getPatternsForEvent: vi.fn(),
  getActionById: vi.fn().mockImplementation((id: number) => 
    Promise.resolve(actions.find(a => a.id === id))
  ),
  getReactionsForEvent: vi.fn(),
  clearCache: vi.fn(),
})

// Mock DB
const createMockDb = () => ({
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  }),
})

describe('ActionExecutor', () => {
  let executor: ActionExecutor
  let mockDb: any
  let mockLoader: CatalogLoader
  let context: MotorContext

  beforeEach(() => {
    mockDb = createMockDb()
    mockLoader = createMockCatalogLoader([])
    executor = new ActionExecutor(mockDb, mockLoader)
    context = {
      taskId: 'task-1',
      subtaskId: 100,
      executionId: 'exec-1',
      generation: 1,
    }
  })

  it('should execute action with all primitives succeeding', async () => {
    const action: CatalogAction = {
      id: 1,
      code: 'test_action',
      name: 'Test Action',
      primitives: [
        { primitive: 'log', params: { level: 'info', message: 'step 1' } },
        { primitive: 'log', params: { level: 'info', message: 'step 2' } },
      ],
      onPartialFailure: 'continue',
      compensationActionId: null,
      isTerminal: false,
      active: true,
    }
    mockLoader = createMockCatalogLoader([action])
    executor = new ActionExecutor(mockDb, mockLoader)

    const logHandler: PrimitiveHandler = vi.fn().mockResolvedValue({ success: true })
    executor.registerPrimitive('log', logHandler)

    const result = await executor.execute(1, context)

    expect(result.success).toBe(true)
    expect(result.primitivesExecuted).toHaveLength(2)
    expect(result.primitivesExecuted).toEqual(['log', 'log'])
    expect(logHandler).toHaveBeenCalledTimes(2)
  })

  it('should handle primitive failure with on_partial_failure=continue', async () => {
    const action: CatalogAction = {
      id: 1,
      code: 'test_action',
      name: 'Test Action',
      primitives: [
        { primitive: 'fail_prim' },
        { primitive: 'log' },
      ],
      onPartialFailure: 'continue',
      compensationActionId: null,
      isTerminal: false,
      active: true,
    }
    mockLoader = createMockCatalogLoader([action])
    executor = new ActionExecutor(mockDb, mockLoader)

    const failHandler: PrimitiveHandler = vi.fn().mockResolvedValue({ success: false, message: 'prim failed' })
    const logHandler: PrimitiveHandler = vi.fn().mockResolvedValue({ success: true })
    executor.registerPrimitive('fail_prim', failHandler)
    executor.registerPrimitive('log', logHandler)

    const result = await executor.execute(1, context)

    expect(result.success).toBe(true) // continue mode
    expect(result.primitivesExecuted).toContain('log')
  })

  it('should handle primitive failure with on_partial_failure=compensate', async () => {
    const compensationAction: CatalogAction = {
      id: 99,
      code: 'compensate_action',
      name: 'Compensate',
      primitives: [{ primitive: 'rollback' }],
      onPartialFailure: 'continue',
      compensationActionId: null,
      isTerminal: false,
      active: true,
    }
    const action: CatalogAction = {
      id: 1,
      code: 'test_action',
      name: 'Test Action',
      primitives: [{ primitive: 'fail_prim' }],
      onPartialFailure: 'compensate',
      compensationActionId: 99,
      isTerminal: false,
      active: true,
    }
    mockLoader = createMockCatalogLoader([action, compensationAction])
    executor = new ActionExecutor(mockDb, mockLoader)

    const failHandler: PrimitiveHandler = vi.fn().mockResolvedValue({ success: false, message: 'prim failed' })
    const rollbackHandler: PrimitiveHandler = vi.fn().mockResolvedValue({ success: true })
    executor.registerPrimitive('fail_prim', failHandler)
    executor.registerPrimitive('rollback', rollbackHandler)

    const result = await executor.execute(1, context)

    expect(result.success).toBe(false)
    expect(result.compensated).toBe(true)
    expect(rollbackHandler).toHaveBeenCalled()
  })

  it('should handle primitive failure with on_partial_failure=mark_dirty', async () => {
    const action: CatalogAction = {
      id: 1,
      code: 'test_action',
      name: 'Test Action',
      primitives: [{ primitive: 'fail_prim' }],
      onPartialFailure: 'mark_dirty',
      compensationActionId: null,
      isTerminal: false,
      active: true,
    }
    mockLoader = createMockCatalogLoader([action])
    executor = new ActionExecutor(mockDb, mockLoader)

    const failHandler: PrimitiveHandler = vi.fn().mockResolvedValue({ success: false, message: 'prim failed' })
    executor.registerPrimitive('fail_prim', failHandler)

    const result = await executor.execute(1, context)

    expect(result.success).toBe(false)
    expect(mockDb.insert).toHaveBeenCalled() // mark_dirty inserts into motor_promotion_state
  })

  it('should handle unregistered primitive gracefully', async () => {
    const action: CatalogAction = {
      id: 1,
      code: 'test_action',
      name: 'Test Action',
      primitives: [{ primitive: 'unregistered_prim' }],
      onPartialFailure: 'continue',
      compensationActionId: null,
      isTerminal: false,
      active: true,
    }
    mockLoader = createMockCatalogLoader([action])
    executor = new ActionExecutor(mockDb, mockLoader)

    const result = await executor.execute(1, context)

    expect(result.success).toBe(true) // continue mode
    expect(result.primitivesExecuted).toHaveLength(0)
  })

  it('should handle primitive throwing exception', async () => {
    const action: CatalogAction = {
      id: 1,
      code: 'test_action',
      name: 'Test Action',
      primitives: [{ primitive: 'throw_prim' }, { primitive: 'log' }],
      onPartialFailure: 'continue',
      compensationActionId: null,
      isTerminal: false,
      active: true,
    }
    mockLoader = createMockCatalogLoader([action])
    executor = new ActionExecutor(mockDb, mockLoader)

    const throwHandler: PrimitiveHandler = vi.fn().mockRejectedValue(new Error('boom'))
    const logHandler: PrimitiveHandler = vi.fn().mockResolvedValue({ success: true })
    executor.registerPrimitive('throw_prim', throwHandler)
    executor.registerPrimitive('log', logHandler)

    const result = await executor.execute(1, context)

    expect(result.success).toBe(true) // continue mode
    expect(result.primitivesExecuted).toContain('log')
  })

  it('should execute action by code', async () => {
    const action: CatalogAction = {
      id: 1,
      code: 'test_action',
      name: 'Test Action',
      primitives: [{ primitive: 'log' }],
      onPartialFailure: 'continue',
      compensationActionId: null,
      isTerminal: false,
      active: true,
    }
    mockLoader = createMockCatalogLoader([action])
    executor = new ActionExecutor(mockDb, mockLoader)

    const logHandler: PrimitiveHandler = vi.fn().mockResolvedValue({ success: true })
    executor.registerPrimitive('log', logHandler)

    const result = await executor.executeByCode('test_action', context)

    expect(result.success).toBe(true)
    expect(result.actionCode).toBe('test_action')
  })

  it('should return error for non-existent action', async () => {
    const result = await executor.execute(999, context)

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('should return error for non-existent action code', async () => {
    const result = await executor.executeByCode('non_existent', context)

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('should list registered primitives', () => {
    executor.registerPrimitive('log', vi.fn())
    executor.registerPrimitive('git_commit', vi.fn())

    const primitives = executor.getRegisteredPrimitives()

    expect(primitives).toContain('log')
    expect(primitives).toContain('git_commit')
  })
})
