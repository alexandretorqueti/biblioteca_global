import { describe, expect, it } from 'vitest'
import { blockerEvidence } from '../src/policies/BlockerPolicy.js'

describe('BlockerPolicy', () => {
  it('normaliza a evidência sem perder a classificação', () => {
    expect(blockerEvidence('systemic_failure', 'Porta 3003 ocupada pelo PID 1234')).toEqual({
      kind: 'systemic_failure',
      fingerprint: 'porta <n> ocupada pelo pid <n>',
      excerpt: 'Porta 3003 ocupada pelo PID 1234',
    })
  })
})
