import { describe, expect, it } from 'vitest'
import { TestGateService } from '../src/testing/TestGateService.js'

describe('TestGateService', () => {
  const service = new TestGateService({} as never)

  it('normaliza caminhos de worktrees e reconhece a mesma falha no baseline', () => {
    const baseline = service.parseFailures(`FAIL projects/app/test/example.test.ts > exemplo > falha\nAssertionError: expected 1 to be 2\n at /data/workspace/projects/agentes/x/worktrees/task/1/a1/projects/app/test/example.test.ts:10:2`)
    const after = service.parseFailures(`FAIL projects/app/test/example.test.ts > exemplo > falha\nAssertionError: expected 1 to be 2\n at /data/workspace/projects/agentes/y/worktrees/task/1/a1/projects/app/test/example.test.ts:10:2`)
    const result = service.compare(after, baseline)
    expect(result.newFailures).toHaveLength(0)
    expect(result.preExistingFailures).toHaveLength(1)
    expect(result.preExistingFailures[0]?.classification).toBe('pre_existing')
  })

  it('classifica falhas novas e resolvidas', () => {
    const baseline = service.parseFailures(`FAIL tests/old.test.ts > antigo\nError: erro antigo`)
    const after = service.parseFailures(`FAIL tests/new.test.ts > novo\nTypeError: erro novo`)
    const result = service.compare(after, baseline)
    expect(result.newFailures.map(failure => failure.suite)).toEqual(['tests/new.test.ts'])
    expect(result.resolvedFailures.map(failure => failure.suite)).toEqual(['tests/old.test.ts'])
  })

  it('transforma falha de setup sem suíte em fingerprint auditável', () => {
    const failures = service.parseFailures(`npm error command failed\nError: Cannot find module 'vitest'`)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ suite: 'test-setup', errorType: 'SetupFailure' })
  })

  it('classifica aumento de ocorrências como worsened', () => {
    const baseline = service.parseFailures(`FAIL tests/a.test.ts > caso\nError: boom`)
    const after = service.parseFailures(`FAIL tests/a.test.ts > caso\nError: boom\nFAIL tests/a.test.ts > caso\nError: boom`)
    const result = service.compare(after, baseline)
    expect(result.newFailures).toHaveLength(1)
    expect(result.newFailures[0]?.classification).toBe('worsened')
  })
})
