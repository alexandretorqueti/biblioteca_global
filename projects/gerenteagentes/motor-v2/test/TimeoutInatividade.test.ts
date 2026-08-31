/**
 * B7 — timeout de inatividade no ConsoleAgentRuntimeDriver (2026-08-31, Alexandre).
 *
 * Regra nova: enquanto o run reporta atividade (hasActiveRun/busy/running/
 * streaming), o prazo é renovado — modelo trabalhando não é interrompido por
 * relógio. Falha só por inatividade (estado-limbo/console fora por
 * idleTimeoutMs) ou pelo teto absoluto.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { ConsoleAgentRuntimeDriver } from '../src/runtime/ConsoleAgentRuntimeDriver.js'

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload }
}

function makeDriver() {
  return new ConsoleAgentRuntimeDriver({ baseUrl: 'http://console.local', token: 't' })
}

const session = { key: 's1', agentId: 'a1' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('B7 — timeout de inatividade', () => {
  it('run ativo por vários polls não é interrompido; conclui quando termina', async () => {
    const responses: unknown[] = [
      { state: 'busy', hasActiveRun: true },
      { state: 'busy', hasActiveRun: true },
      { state: 'busy', hasActiveRun: true },
      { state: 'busy', hasActiveRun: true },
      { state: 'done', hasActiveRun: false },
    ]
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/api/chat/history')) {
        return jsonResponse({ messages: [{ role: 'assistant', content: 'entrega pronta' }] })
      }
      return jsonResponse(responses.shift() ?? { state: 'done' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onActivity = vi.fn()

    const driver = makeDriver()
    const result = await driver.waitForRunCompletion(session, 'run-1', {
      pollIntervalMs: 10, idleTimeoutMs: 50, absoluteTimeoutMs: 60_000, onActivity,
    })

    expect(result.state).toBe('final')
    expect(result.content).toBe('entrega pronta')
    expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(4) // renovado em cada poll ativo
  })

  it('estado-limbo contínuo (nem ativo nem terminal) → timeout por inatividade', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ state: 'queued' })))

    const driver = makeDriver()
    await expect(driver.waitForRunCompletion(session, 'run-2', {
      pollIntervalMs: 10, idleTimeoutMs: 60, absoluteTimeoutMs: 60_000,
    })).rejects.toThrow(/inatividade/)
  })

  it('console inalcançável não conta como atividade → timeout por inatividade', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))

    const driver = makeDriver()
    await expect(driver.waitForRunCompletion(session, 'run-3', {
      pollIntervalMs: 10, idleTimeoutMs: 60, absoluteTimeoutMs: 60_000,
    })).rejects.toThrow(/inatividade/)
  })

  it('run ativo sem fim cai no teto absoluto (segurança contra zumbi)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ state: 'busy', hasActiveRun: true })))

    const driver = makeDriver()
    await expect(driver.waitForRunCompletion(session, 'run-4', {
      pollIntervalMs: 10, idleTimeoutMs: 60_000, absoluteTimeoutMs: 80,
    })).rejects.toThrow(/absoluto/)
  })

  it('hasActiveRun=false segue para histórico imediatamente (sem esperar)', async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url)
      if (u.includes('/api/chat/history')) {
        return jsonResponse({ messages: [{ role: 'assistant', content: 'fim' }] })
      }
      return jsonResponse({ hasActiveRun: false })
    })
    vi.stubGlobal('fetch', fetchMock)

    const driver = makeDriver()
    const result = await driver.waitForRunCompletion(session, 'run-5', { pollIntervalMs: 10 })

    expect(result.state).toBe('final')
    expect(result.content).toBe('fim')
  })
})
