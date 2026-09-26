import { describe, expect, it, vi } from 'vitest'
import { WorkerConsoleAdapter } from '../src/execution/WorkerConsoleAdapter.js'

describe('WorkerConsoleAdapter', () => {
  it('persiste a sessão antes de devolvê-la ao worker e permite reassociação', async () => {
    const consoleApi = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'runtime-1', sessionKey: 'dev-model-task-s1', agentId: 'dev' }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getSessionStatus: vi.fn().mockResolvedValue({ isComplete: false }),
    }
    const onSessionCreated = vi.fn().mockResolvedValue(undefined)
    const adapter = new WorkerConsoleAdapter(consoleApi as never, { onSessionCreated })

    await adapter.createSession({
      key: 'dev-model-task-s1', agentId: 'dev', model: 'provider/model',
      metadata: { databaseTaskId: 1, subtaskId: 2, executionId: 'exec-1' },
    })

    expect(onSessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'runtime-1', sessionKey: 'dev-model-task-s1' }),
      expect.objectContaining({ model: 'provider/model', metadata: expect.objectContaining({ executionId: 'exec-1' }) }),
    )
    expect(adapter.isLocallyOwned('runtime-1')).toBe(true)

    const recovered = { sessionId: 'runtime-2', sessionKey: 'dev-model-task-s2', agentId: 'dev' }
    adapter.attachSession(recovered)
    expect(adapter.isLocallyOwned('runtime-2')).toBe(false)
    await adapter.getSessionStatus('runtime-2')
    expect(consoleApi.getSessionStatus).toHaveBeenCalledWith(recovered)
  })
})
