import { describe, expect, it, vi } from 'vitest'
import { GovernedFailureHandler } from '../src/governance/GovernedFailureHandler.js'
import type { MotorContext } from '../src/shared/context.js'

const context: MotorContext = { taskId: 'task-1', subtaskId: 2, executionId: 'exec-1', generation: 1 }

describe('GovernedFailureHandler', () => {
  it('classifies, executes the catalog action and audits the flow', async () => {
    const classifier = { classify: vi.fn().mockResolvedValue({
      event: { code: 'E01' }, action: { id: 7, code: 'A01' }, occurrence: 1, reaction: { id: 1 },
    }) }
    const executor = { execute: vi.fn().mockResolvedValue({ actionCode: 'A01', success: true, primitivesExecuted: ['log'], compensated: false }) }
    const audit = vi.fn()
    const handler = new GovernedFailureHandler(classifier as any, executor as any, { audit })

    const result = await handler.handleFailure('analysis', context, { code: 'X', message: 'failure' })

    expect(result.governed).toBe(true)
    expect(executor.execute).toHaveBeenCalledWith(7, context)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'classified', eventCode: 'E01' }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'executed', actionCode: 'A01' }))
  })

  it('uses the legacy fallback when disabled or when the governed pipeline fails', async () => {
    const fallback = vi.fn().mockResolvedValue('legacy')
    const classifier = { classify: vi.fn().mockRejectedValue(new Error('catalog unavailable')) }
    const executor = { execute: vi.fn() }
    const handler = new GovernedFailureHandler(classifier as any, executor as any, {
      flagResolver: vi.fn().mockResolvedValue(false), fallback,
    })
    expect((await handler.handleFailure('analysis', context, { message: 'x' })).fallbackResult).toBe('legacy')

    const enabledHandler = new GovernedFailureHandler(classifier as any, executor as any, { fallback })
    expect((await enabledHandler.handleFailure('analysis', context, { message: 'x' })).fallbackResult).toBe('legacy')
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('sends uncatalogued errors to Monitor without classifying twice', async () => {
    const classifier = { classify: vi.fn().mockResolvedValue(null) }
    const executor = { execute: vi.fn() }
    const monitor = { handleUncataloguedError: vi.fn().mockResolvedValue({ proposalId: 'p1', case: 'B' }) }
    const handler = new GovernedFailureHandler(classifier as any, executor as any, { monitor: monitor as any })

    const result = await handler.handleFailure('worker', context, { message: 'unknown' })

    expect(result.proposal).toEqual({ proposalId: 'p1', case: 'B' })
    expect(classifier.classify).toHaveBeenCalledTimes(1)
    expect(monitor.handleUncataloguedError).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }), expect.anything(), true)
  })
})

