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

  it('ignora done obsoleto até a nova execução produzir atividade', async () => {
    const session = { sessionId: 's-race', sessionKey: 'agent:a:race', agentId: 'a' }
    vi.stubGlobal('fetch', vi.fn()
      // sendMessage: histórico anterior + envio aceito
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'old-response', role: 'assistant', content: 'CONTEXTO_RECEBIDO', createdAt: 1 }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      // Primeira consulta: describe ainda mostra o done anterior e o histórico
      // só contém a mensagem antiga e o novo prompt do usuário.
      .mockResolvedValueOnce(jsonResponse({ status: 'done', hasActiveRun: false, endedAt: 1 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        { id: 'old-response', role: 'assistant', content: 'CONTEXTO_RECEBIDO', createdAt: 1 },
        { id: 'new-prompt', role: 'user', content: 'Analise agora', createdAt: Date.now() },
      ] }))
      // Depois a execução nova aparece como running.
      .mockResolvedValueOnce(jsonResponse({ status: 'running', hasActiveRun: true }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        { id: 'old-response', role: 'assistant', content: 'CONTEXTO_RECEBIDO', createdAt: 1 },
        { id: 'new-prompt', role: 'user', content: 'Analise agora', createdAt: Date.now() },
        { id: 'new-tool', role: 'assistant', stopReason: 'toolUse', content: 'consultando arquivos', createdAt: Date.now() },
      ] }))
      // E somente a resposta final nova conclui a espera.
      .mockResolvedValueOnce(jsonResponse({ status: 'done', hasActiveRun: false, endedAt: 2 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        { id: 'old-response', role: 'assistant', content: 'CONTEXTO_RECEBIDO', createdAt: 1 },
        { id: 'new-final', role: 'assistant', stopReason: 'stop', content: '{"subtarefas":[]}', createdAt: Date.now() },
      ] })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await api.sendMessage({ session, message: 'Analise agora' })

    await expect(api.getSessionStatus(session)).resolves.toEqual({ isComplete: false })
    await expect(api.getSessionStatus(session)).resolves.toEqual({
      isComplete: false,
      activity: { repeatedToolCalls: 1, fingerprint: expect.stringMatching(/^[a-f0-9]{24}$/) },
    })
    await expect(api.getSessionStatus(session)).resolves.toEqual({ isComplete: true, lastResponse: '{"subtarefas":[]}' })
  })

  it('expõe done do envio atual quando houve ferramenta nova mas faltou resposta final', async () => {
    const session = { sessionId: 's-tool-end', sessionKey: 'agent:a:tool-end', agentId: 'a' }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'old', role: 'assistant', content: 'CONTEXTO_RECEBIDO' }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ status: 'done', hasActiveRun: false, endedAt: 2 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        { id: 'old', role: 'assistant', content: 'CONTEXTO_RECEBIDO' },
        { id: 'new-tool', role: 'assistant', stopReason: 'toolUse', content: 'consultando arquivos' },
      ] })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await api.sendMessage({ session, message: 'Analise agora' })

    await expect(api.getSessionStatus(session)).resolves.toEqual({ isComplete: true })
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

  it('ignora narrações variáveis e detecta chamadas tool reais repetidas como no incidente 815', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'running', hasActiveRun: true }))
      .mockResolvedValueOnce(jsonResponse({
        messages: Array.from({ length: 6 }, (_, index) => [
          { role: 'assistant', stopReason: 'toolUse', content: `Vou conferir novamente ${index}` },
          { role: 'tool', toolName: 'process', stopReason: 'toolUse', content: 'process\n{\n  "action": "list"\n}' },
          { role: 'tool', content: 'mild-trail completed 19s' },
        ]).flat(),
      })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await expect(api.getSessionStatus({ sessionId: 's-loop-815', sessionKey: 'agent:a:loop-815', agentId: 'a' }))
      .resolves.toEqual({ isComplete: false, activity: { fingerprint: expect.stringMatching(/^[a-f0-9]{24}$/), repeatedToolCalls: 6 } })
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
