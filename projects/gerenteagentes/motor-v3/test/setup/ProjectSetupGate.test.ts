import { describe, expect, it } from 'vitest'
import { validateProjectSetupEvidence } from '../../src/setup/ProjectSetupGate.js'

const valid = {
  checklist: { structure: true, configSchemaMigrations: true, registries: true, repoPath: true },
  smoke_test: { url: 'http://localhost:3000/api/demo/', method: 'GET', status: 200, response_body: '{}', timestamp: '2026-10-20T00:00:00.000Z' },
}

describe('ProjectSetupGate', () => {
  it('accepts checklist complete with HTTP 2xx JSON evidence', () => {
    expect(validateProjectSetupEvidence(valid).ok).toBe(true)
  })

  it('rejects incomplete checklist', () => {
    const result = validateProjectSetupEvidence({ ...valid, checklist: { ...valid.checklist, registries: false } })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reasons).toContain('checklist incompleto: registries')
  })

  it('rejects missing or non-2xx smoke evidence', () => {
    expect(validateProjectSetupEvidence({ ...valid, smoke_test: undefined }).ok).toBe(false)
    expect(validateProjectSetupEvidence({ ...valid, smoke_test: { ...valid.smoke_test, status: 500 } }).ok).toBe(false)
  })

  it('requires agentLink when the checklist declares it applicable', () => {
    const result = validateProjectSetupEvidence({ ...valid, checklist: { ...valid.checklist, agentLink: false } })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reasons).toContain('checklist incompleto: agentLink')
  })
})
