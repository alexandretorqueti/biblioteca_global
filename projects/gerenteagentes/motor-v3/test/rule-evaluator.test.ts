import { describe, expect, it } from 'vitest'
import { RuleEvaluator } from '../src/governance/RuleEvaluator.js'

describe('RuleEvaluator', () => {
  const evaluator = new RuleEvaluator()
  const input = { error: { errorClass: 'environment_failure', message: 'git failed' }, context: { attempt: 2 }, occurrence: 2 }

  it('supports all, any and scalar operators', () => {
    expect(evaluator.evaluate({ all: [
      { field: 'error.errorClass', op: 'eq', value: 'environment_failure' },
      { any: [
        { field: 'context.attempt', op: 'gte', value: 2 },
        { field: 'occurrence', op: 'eq', value: 99 },
      ] },
    ] }, input)).toBe(true)
    expect(evaluator.evaluate({ field: 'error.message', op: 'contains', value: 'git' }, input)).toBe(true)
    expect(evaluator.evaluate({ field: 'error.message', op: 'regex', value: '^git' }, input)).toBe(true)
    expect(evaluator.evaluate({ field: 'errorClass', op: 'eq', value: 'environment_failure' }, { ...input, errorClass: 'environment_failure' })).toBe(true)
    expect(evaluator.evaluate({ field: 'context.attempt', op: 'lte', value: 1 }, input)).toBe(false)
    expect(evaluator.evaluate({ field: 'error.errorClass', op: 'neq', value: 'timeout' }, input)).toBe(true)
  })

  it('rejects malformed and invalid regex conditions without executing them', () => {
    expect(evaluator.evaluate({ field: 'error.message', op: 'regex', value: '[' }, input)).toBe(false)
    expect(evaluator.evaluate({ field: 'error.message' }, input)).toBe(false)
    expect(evaluator.evaluate({ field: 'missing.value', op: 'eq', value: 'x' }, input)).toBe(false)
  })
})
