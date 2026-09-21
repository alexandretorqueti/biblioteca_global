import { describe, expect, it, vi } from 'vitest'
import { DerivedTaskStatusResolver } from '../src/status/DerivedTaskStatus.js'

describe('DerivedTaskStatusResolver', () => {
  it('deriva failed quando qualquer subtarefa falhou definitivamente', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        id: 855, paused_at: null, resource_wait_key: null,
        analysis_started_at: null, terminal_status: null,
        last_clarification_role: null, awaiting_interaction: 0,
        has_active_blocker: 0, deploy_succeeded: 0, deploy_failed: 0,
      }]])
      .mockResolvedValueOnce([[{ status: 'failed' }]])
    const resolver = new DerivedTaskStatusResolver({ query } as never)
    await expect(resolver.resolve('task-p6-855')).resolves.toBe('failed')
  })
})
// @vitest-environment node
