import { describe, expect, it } from 'vitest'
import { detectAdditiveConflict, mergeAdditive } from '../src/deploy/AdditiveHotspotMerge.js'

describe('AdditiveHotspotMerge', () => {
  it('funde imports/registros no mesmo âncora em ordem canônica', () => {
    const base = "import { Core } from './Core.js'\n\nexport const registry = [\n] as const\n"
    const ours = "import { Core } from './Core.js'\nimport { Zeta } from './Zeta.js'\n\nexport const registry = [\n  'zeta',\n] as const\n"
    const theirs = "import { Core } from './Core.js'\nimport { Alpha } from './Alpha.js'\n\nexport const registry = [\n  'alpha',\n] as const\n"

    expect(detectAdditiveConflict(base, ours, theirs)).toBe('puramente aditivo')
    expect(mergeAdditive(base, ours, theirs)).toBe("import { Core } from './Core.js'\nimport { Alpha } from './Alpha.js'\nimport { Zeta } from './Zeta.js'\n\nexport const registry = [\n  'alpha',\n  'zeta',\n] as const\n")
  })

  it('preserva âncoras distintos e deduplica linha idêntica', () => {
    const base = 'start\nend\n'
    const ours = 'start\nalpha\nshared\nend\n'
    const theirs = 'start\nshared\nend\nomega\n'

    expect(mergeAdditive(base, ours, theirs)).toBe('start\nalpha\nshared\nend\nomega\n')
  })

  it.each([
    ['deleção', 'start\n', 'start\nend\n'],
    ['modificação', 'start\nchanged\n', 'start\nend\n'],
  ])('rejeita %s de linha existente', (_kind, ours, theirs) => {
    const base = 'start\nend\n'
    expect(detectAdditiveConflict(base, ours, theirs)).toBe('não-aditivo')
    expect(mergeAdditive(base, ours, theirs)).toBeNull()
  })

  it('mantém saída byte-idêntica em execuções repetidas', () => {
    const base = 'core\n'
    const ours = 'core\nimport Z\n'
    const theirs = 'core\nimport A\n'
    const outputs = Array.from({ length: 5 }, () => mergeAdditive(base, ours, theirs))
    expect(new Set(outputs).size).toBe(1)
    expect(outputs[0]).toBe('core\nimport A\nimport Z\n')
  })
})
