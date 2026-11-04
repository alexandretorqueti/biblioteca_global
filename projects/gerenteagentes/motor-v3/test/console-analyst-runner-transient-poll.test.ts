// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ConsoleAnalystRunner } from '../src/analysis/ConsoleAnalystRunner.js'
import type { AnalystSession, ConsoleSessionStatus } from '../src/analysis/ConsoleAnalystRunner.js'

/**
 * Incidente task-p2-1060: `Console HTTP 504: Gateway request timed out:
 * sessions.describe` durante o polling queimou a cadeia inteira de modelos da
 * tentativa. Erros transitórios de Console/Gateway devem ser tolerados até um
 * limite de ocorrências consecutivas; além dele (ou para erros não
 * transitórios), o erro propaga para o tratamento existente.
 */
describe('ConsoleAnalystRunner — waitForResult tolerante a erros transitórios', () => {
  const session: AnalystSession = { sessionId: 's1', sessionKey: 'k1', agentId: 'a1' }
  const task = { taskId: 'task-x' } as never

  const buildRunner = (getSessionStatus: () => Promise<ConsoleSessionStatus>) => {
    const runner = new ConsoleAnalystRunner(
      {
        createSession: async () => session,
        sendMessage: async () => {},
        getSessionStatus,
      },
      { timeoutMs: 30_000, pollIntervalMs: 1, workspacePreflight: false },
    )
    return (runner as unknown as { waitForResult: (session: AnalystSession, task: unknown) => Promise<string> }).waitForResult.bind(runner)
  }

  it('não consome a tentativa quando o describe devolve 504 transitório e depois conclui', async () => {
    let calls = 0
    const waitForResult = buildRunner(async () => {
      calls++
      if (calls <= 3) throw new Error('Console HTTP 504: {"error":{"code":"TIMEOUT","message":"Gateway request timed out: sessions.describe"}}')
      return { isComplete: true, lastResponse: 'resposta final' }
    })

    await expect(waitForResult(session, task)).resolves.toBe('resposta final')
    expect(calls).toBe(4)
  })

  it('propaga o 504 quando os erros transitórios excedem o limite consecutivo', async () => {
    let calls = 0
    const waitForResult = buildRunner(async () => {
      calls++
      throw new Error('Console HTTP 504: {"error":{"code":"TIMEOUT","message":"Gateway request timed out: sessions.describe"}}')
    })

    await expect(waitForResult(session, task)).rejects.toThrow(/Console HTTP 504/)
    // Limite de 24 erros consecutivos + a chamada que excede o limite.
    expect(calls).toBe(25)
  })

  it('propaga imediatamente erro não transitório (ex.: 401)', async () => {
    let calls = 0
    const waitForResult = buildRunner(async () => {
      calls++
      throw new Error('Console HTTP 401: Unauthorized')
    })

    await expect(waitForResult(session, task)).rejects.toThrow(/Console HTTP 401/)
    expect(calls).toBe(1)
  })

  it('reinicia a contagem após uma consulta bem-sucedida', async () => {
    let calls = 0
    const waitForResult = buildRunner(async () => {
      calls++
      // Padrão: 20 erros transitórios, 1 sucesso (incompleto), mais 20 erros,
      // depois conclusão. Nenhum trecho atinge o limite de 24 consecutivos.
      if (calls === 21) return { isComplete: false }
      if (calls <= 20 || (calls >= 22 && calls <= 41)) {
        throw new Error('Console HTTP 503: Service Unavailable')
      }
      return { isComplete: true, lastResponse: 'ok' }
    })

    await expect(waitForResult(session, task)).resolves.toBe('ok')
    expect(calls).toBe(42)
  })
})
