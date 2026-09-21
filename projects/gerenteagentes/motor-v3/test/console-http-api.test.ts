import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleHttpApi } from '../src/analysis/ConsoleHttpApi.js'

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

describe('ConsoleHttpApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('transforma falha genérica do histórico em assinatura recuperável', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', endedAt: 1 }))
      .mockResolvedValueOnce(jsonResponse({
        messages: [{ role: 'assistant', stopReason: 'error', content: 'The agent run failed before producing a reply.' }],
      })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    const status = await api.getSessionStatus({ sessionId: 's1', sessionKey: 'agent:a:k', agentId: 'a' })

    expect(status).toEqual({
      isComplete: false,
      isFailed: true,
      error: 'SESSION_FAILED: The agent run failed before producing a reply.',
    })
  })

  it('prioriza o detalhe estruturado da falha remota', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: { code: 'RATE_LIMIT', message: '429 quota exhausted' } }))
      .mockResolvedValueOnce(jsonResponse({ messages: [] })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    const status = await api.getSessionStatus({ sessionId: 's2', sessionKey: 'agent:a:k2', agentId: 'a' })

    expect(status.error).toBe('429 quota exhausted')
  })
})
// @vitest-environment node
