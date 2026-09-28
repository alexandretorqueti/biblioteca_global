import { describe, expect, it } from 'vitest'
import { ConsoleAnalystRunner } from '../src/analysis/ConsoleAnalystRunner.js'

/**
 * O método `isModelUnavailable` é privado, mas podemos testá-lo indiretamente
 * verificando se o `modelFailureRecorder` é chamado quando o modelo falha com
 * erros que indicam indisponibilidade/instabilidade.
 *
 * Para testes diretos, usamos um proxy para acessar o método privado.
 */
describe('ConsoleAnalystRunner — isModelUnavailable', () => {
  const runner = new ConsoleAnalystRunner(
    {
      createSession: async () => ({ sessionId: 's1', sessionKey: 'k1', agentId: 'a1' }),
      sendMessage: async () => {},
      getSessionStatus: async () => ({ isComplete: true, lastResponse: 'ok' }),
    },
    { timeoutMs: 1000, pollIntervalMs: 100 },
  )

  // Acessa o método privado via type assertion
  const isModelUnavailable = (runner as unknown as { isModelUnavailable: (error: Error) => boolean }).isModelUnavailable.bind(runner)

  it('detecta erros HTTP de autenticação/quota', () => {
    expect(isModelUnavailable(new Error('Console HTTP 401: Unauthorized'))).toBe(true)
    expect(isModelUnavailable(new Error('Console HTTP 403: Forbidden'))).toBe(true)
    expect(isModelUnavailable(new Error('Console HTTP 404: Not Found'))).toBe(true)
    expect(isModelUnavailable(new Error('Console HTTP 429: Too Many Requests'))).toBe(true)
  })

  it('detecta erros de quota e billing', () => {
    expect(isModelUnavailable(new Error('quota exceeded'))).toBe(true)
    expect(isModelUnavailable(new Error('rate limit reached'))).toBe(true)
    expect(isModelUnavailable(new Error('credit insufficient'))).toBe(true)
    expect(isModelUnavailable(new Error('billing error'))).toBe(true)
  })

  it('detecta timeout', () => {
    expect(isModelUnavailable(new Error('Gateway request timed out: sessions.create'))).toBe(true)
    expect(isModelUnavailable(new Error('timeout waiting for response'))).toBe(true)
    expect(isModelUnavailable(new Error('Timeout aguardando análise da tarefa'))).toBe(true)
  })

  it('detecta modelo indisponível', () => {
    expect(isModelUnavailable(new Error('model not found: deepseek-v4'))).toBe(true)
    expect(isModelUnavailable(new Error('model not allowed for this project'))).toBe(true)
    expect(isModelUnavailable(new Error('modelo indisponível'))).toBe(true)
    expect(isModelUnavailable(new Error('Modelo Indisponível temporariamente'))).toBe(true)
  })

  it('detecta resposta vazia/ausente (NOVO)', () => {
    expect(isModelUnavailable(new Error('Analista concluiu sem resposta'))).toBe(true)
    expect(isModelUnavailable(new Error('O modelo retornou sem resposta'))).toBe(true)
    expect(isModelUnavailable(new Error('empty response from model'))).toBe(true)
    expect(isModelUnavailable(new Error('no response received'))).toBe(true)
  })

  it('rejeita erros genéricos de análise', () => {
    expect(isModelUnavailable(new Error('Analista não confirmou o bloco 1/3'))).toBe(false)
    expect(isModelUnavailable(new Error('Resposta não atende ao contrato'))).toBe(false)
    expect(isModelUnavailable(new Error('Console não retornou sessionId'))).toBe(false)
  })
})
