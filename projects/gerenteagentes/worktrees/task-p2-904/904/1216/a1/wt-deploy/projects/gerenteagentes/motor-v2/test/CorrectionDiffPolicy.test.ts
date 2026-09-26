import { describe, expect, it } from 'vitest'
import { correctionOnlyChangesTests } from '../src/policies/CorrectionDiffPolicy.js'

describe('CorrectionDiffPolicy', () => {
  it('aceita somente alterações de testes', () => {
    expect(correctionOnlyChangesTests(['src/a.test.ts', 'tests/integration/x.ts'])).toBe(true)
    expect(correctionOnlyChangesTests(['src/a.ts', 'src/a.test.ts'])).toBe(false)
  })
})
