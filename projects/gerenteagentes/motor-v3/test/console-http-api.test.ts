import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsoleHttpApi } from '../src/analysis/ConsoleHttpApi.js'

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

describe('ConsoleHttpApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

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

  it('ignora failed obsoleto entre o envio e o início do novo run (incidente 1336)', async () => {
    const session = { sessionId: 's-failed-race', sessionKey: 'agent:a:failed-race', agentId: 'a' }
    const oldError = { id: 'old-error', role: 'assistant', stopReason: 'error', content: 'falha anterior', errorMessage: '400 data_inspection_failed', createdAt: 1 }
    vi.stubGlobal('fetch', vi.fn()
      // sendMessage: histórico anterior (com o erro do run antigo) + envio aceito
      .mockResolvedValueOnce(jsonResponse({ messages: [oldError] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      // Primeira consulta: describe ainda expõe o failed do run ANTERIOR e o
      // histórico não tem atividade do agente depois do marcador.
      .mockResolvedValueOnce(jsonResponse({ status: 'failed' }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        oldError,
        { id: 'new-prompt', role: 'user', content: 'Continue o trabalho', createdAt: Date.now() },
      ] }))
      // Segunda consulta: enquanto há atividade nova após o marcador, o
      // describe ainda pode refletir o failed terminal do run anterior.
      .mockResolvedValueOnce(jsonResponse({ status: 'failed' }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        oldError,
        { id: 'new-prompt', role: 'user', content: 'Continue o trabalho', createdAt: Date.now() },
        { id: 'new-error', role: 'assistant', stopReason: 'error', content: 'falha nova', errorMessage: '500 provider_error', createdAt: Date.now() },
      ] })))
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await api.sendMessage({ session, message: 'Continue o trabalho' })

    // Failed obsoleto não pode consumir a tentativa: segue aguardando.
    await expect(api.getSessionStatus(session)).resolves.toEqual({ isComplete: false })
    // Atividade nova mantém a proteção contra o failed obsoleto.
    await expect(api.getSessionStatus(session)).resolves.toEqual({ isComplete: false })
  })

  it('consome failed além da tolerância sem atividade nova e remove o marker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    vi.stubEnv('MOTOR_CONSOLE_STALE_FAILED_GRACE_MS', '1000')
    const session = { sessionId: 's-failed-expired', sessionKey: 'agent:a:failed-expired', agentId: 'a' }
    const oldError = { id: 'old-error', role: 'assistant', stopReason: 'error', content: 'falha anterior', createdAt: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ messages: [oldError] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', errorMessage: 'falha terminal' }))
      .mockResolvedValueOnce(jsonResponse({ messages: [oldError, { id: 'new-prompt', role: 'user', content: 'continue' }] }))
      // Se o marker não fosse removido, a consulta seguinte ainda seria
      // tratada como uma corrida dentro da tolerância.
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', errorMessage: 'falha terminal' }))
      .mockResolvedValueOnce(jsonResponse({ messages: [oldError, { id: 'new-prompt', role: 'user', content: 'continue' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await api.sendMessage({ session, message: 'continue' })
    vi.setSystemTime(102_000)

    await expect(api.getSessionStatus(session)).resolves.toEqual({
      isComplete: false,
      isFailed: true,
      error: 'falha terminal',
    })
    await expect(api.getSessionStatus(session)).resolves.toEqual({
      isComplete: false,
      isFailed: true,
      error: 'falha terminal',
    })
  })

  it('preserva failed dentro da tolerância sem atividade nova', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    vi.stubEnv('MOTOR_CONSOLE_STALE_FAILED_GRACE_MS', '1000')
    const session = { sessionId: 's-failed-grace', sessionKey: 'agent:a:failed-grace', agentId: 'a' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ messages: [] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', endedAt: 99_000 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'new-prompt', role: 'user', content: 'continue' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await api.sendMessage({ session, message: 'continue' })
    vi.setSystemTime(100_500)

    await expect(api.getSessionStatus(session)).resolves.toEqual({ isComplete: false })
  })

  it('preserva failed antigo quando houve atividade nova após o marker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    vi.stubEnv('MOTOR_CONSOLE_STALE_FAILED_GRACE_MS', '0')
    const session = { sessionId: 's-failed-activity', sessionKey: 'agent:a:failed-activity', agentId: 'a' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ messages: [] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', endedAt: 99_000 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        { id: 'new-prompt', role: 'user', content: 'continue' },
        { id: 'new-tool', role: 'assistant', stopReason: 'toolUse', content: 'consultando arquivos' },
      ] }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await api.sendMessage({ session, message: 'continue' })
    vi.setSystemTime(100_500)

    await expect(api.getSessionStatus(session)).resolves.toEqual({ isComplete: false })
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

  it('busca a resposta final integral via /api/chat/message quando o histórico vem truncado (incidente task-p2-984)', async () => {
    const truncated = `{"subtarefas":[{"seq":1,${'"x":"y",'.repeat(2000)}`.padEnd(8000, 'z') + '\n...(truncated)...'
    const full = `{"subtarefas":[{"seq":1,"titulo":"t"}]}`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'done', hasActiveRun: false, endedAt: 1 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        { id: 'msg-final', role: 'assistant', stopReason: 'stop', content: truncated },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, message: { id: 'msg-final', role: 'assistant', content: full } }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    const status = await api.getSessionStatus({ sessionId: 's7', sessionKey: 'agent:a:k7', agentId: 'a' })

    expect(status).toEqual({ isComplete: true, lastResponse: full })
    const messageCall = new URL(fetchMock.mock.calls[2]![0] as string)
    expect(messageCall.pathname).toBe('/api/chat/message')
    expect(messageCall.searchParams.get('messageId')).toBe('msg-final')
    expect(Number(messageCall.searchParams.get('maxChars'))).toBeGreaterThan(8_000)
  })

  it('mantém o conteúdo truncado quando a mensagem integral não está disponível', async () => {
    const truncated = 'resposta longa '.repeat(700) + '\n...(truncated)...'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'done', hasActiveRun: false, endedAt: 1 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        { id: 'msg-final', role: 'assistant', stopReason: 'stop', content: truncated },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, unavailableReason: 'not_found' }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await expect(api.getSessionStatus({ sessionId: 's8', sessionKey: 'agent:a:k8', agentId: 'a' }))
      .resolves.toEqual({ isComplete: true, lastResponse: truncated })
  })

  it('não chama /api/chat/message quando a resposta final não está truncada', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'done', hasActiveRun: false, endedAt: 1 }))
      .mockResolvedValueOnce(jsonResponse({ messages: [
        { id: 'msg-ok', role: 'assistant', stopReason: 'stop', content: '{"subtarefas":[]}' },
      ] }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ConsoleHttpApi('http://console.local', 'token-de-teste')

    await expect(api.getSessionStatus({ sessionId: 's9', sessionKey: 'agent:a:k9', agentId: 'a' }))
      .resolves.toEqual({ isComplete: true, lastResponse: '{"subtarefas":[]}' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
// @vitest-environment node
