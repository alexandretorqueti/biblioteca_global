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

  it('trata timeout terminal como falha explícita', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'timeout', endedAt: 1 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [] })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await expect(api.getSessionStatus({ sessionId: 's3', sessionKey: 'agent:a:k3', agentId: 'a' }))
      .resolves.toEqual({ isComplete: false, isFailed: true, error: 'Sessão do Console terminou com status timeout' })
  })

  it('expõe sessão done sem resposta final para o protocolo de continuação', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'done', hasActiveRun: false }))
      .mockResolvedValueOnce(jsonResponse({
        messages: [{ id: 'm1', role: 'assistant', stopReason: 'toolUse', content: 'vou consultar arquivos' }],
      })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await expect(api.getSessionStatus({ sessionId: 's4', sessionKey: 'agent:a:k4', agentId: 'a' }))
      .resolves.toEqual({ isComplete: true })
  })

  it('mantém idle sem resposta final como estado não concluído', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'idle', hasActiveRun: false }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'm1', role: 'assistant', stopReason: 'toolUse', content: 'vou consultar arquivos' }] })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await expect(api.getSessionStatus({ sessionId: 's4b', sessionKey: 'agent:a:k4b', agentId: 'a' }))
      .resolves.toEqual({ isComplete: false })
  })

  it('expõe repetição consecutiva de ferramenta enquanto a sessão está ativa', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'running', hasActiveRun: true }))
      .mockResolvedValueOnce(jsonResponse({
        messages: Array.from({ length: 5 }, (_, index) => [
          { role: 'assistant', stopReason: 'toolUse', content: 'npm test -- --runInBand' },
          { role: 'tool', content: `saída variável ${index}` },
        ]).flat(),
      })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await expect(api.getSessionStatus({ sessionId: 's5', sessionKey: 'agent:a:k5', agentId: 'a' }))
      .resolves.toEqual({ isComplete: false, activity: { fingerprint: expect.stringMatching(/^[a-f0-9]{24}$/), repeatedToolCalls: 5 } })
  })

  it('interrompe o run ativo pelo endpoint de abort do Console', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, aborted: true }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await expect(api.abortSession({ sessionId: 's6', sessionKey: 'agent:a:k6', agentId: 'a' }))
      .resolves.toEqual({ aborted: true })
  })
})
// @vitest-environment node
