// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { waitForCompletion } from '../src/primitives/session.js'
import type { PrimitiveContext } from '../src/primitives/types.js'

/**
 * Incidente isas-mt-05/01/07 (bloqueios 3466–3468, 2026-11-17):
 * `Console HTTP 503: {"error":{"code":"UNAVAILABLE","message":"Gateway
 * connection closed"}}` durante o polling de wait_for_completion queimou as 3
 * tentativas do programador e bloqueou três tarefas simultâneas — enquanto a
 * sessão DEV órfã concluía o trabalho no Console. Erros transitórios de
 * Console/Gateway não refletem estado terminal da sessão e devem ser tolerados
 * até um limite de ocorrências consecutivas (mesmo tratamento do analista no
 * incidente task-p2-1060); além dele (ou para erros não transitórios), a falha
 * propaga para o tratamento existente de tentativa.
 */
const buildContext = (getSessionStatus: () => Promise<unknown>): PrimitiveContext => ({
  taskId: 'task-x',
  executionId: 'exec-1',
  generation: 1,
  projectSlug: 'slug-x',
  repoPath: '/repo',
  worktreePath: '/repo/.worktrees/x',
  branchName: 'br-x',
  agentId: 'agent-x',
  db: {},
  sessionId: 's1',
  consoleApi: { getSessionStatus },
})

const wait = (getSessionStatus: () => Promise<unknown>, params?: Record<string, unknown>) =>
  waitForCompletion.handler(buildContext(getSessionStatus), { timeoutMs: 30_000, pollIntervalMs: 1, ...params })

describe('wait_for_completion — tolerante a erros transitórios do Console', () => {
  it('não consome a tentativa quando o status devolve 503 transitório e depois conclui', async () => {
    let calls = 0
    const result = await wait(async () => {
      calls++
      if (calls <= 3) throw new Error('Console HTTP 503: {"error":{"code":"UNAVAILABLE","message":"Gateway connection closed"}}')
      return { isComplete: true, lastResponse: 'resposta final ::DONE::' }
    })

    expect(result.success).toBe(true)
    expect(result.data?.response).toBe('resposta final ::DONE::')
    expect(calls).toBe(4)
  })

  it('falha quando os erros transitórios excedem o limite consecutivo', async () => {
    let calls = 0
    const result = await wait(async () => {
      calls++
      throw new Error('Console HTTP 503: Service Unavailable')
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Erro ao aguardar conclusão: Console HTTP 503/)
    // Limite de 24 erros consecutivos + a chamada que excede o limite.
    expect(calls).toBe(25)
  })

  it('falha imediatamente para erro não transitório (ex.: 401)', async () => {
    let calls = 0
    const result = await wait(async () => {
      calls++
      throw new Error('Console HTTP 401: Unauthorized')
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Erro ao aguardar conclusão: Console HTTP 401/)
    expect(calls).toBe(1)
  })

  it('reinicia a contagem após uma consulta bem-sucedida', async () => {
    let calls = 0
    const result = await wait(async () => {
      calls++
      // Padrão: 20 erros transitórios, 1 sucesso (incompleto), mais 20 erros,
      // depois conclusão. Nenhum trecho atinge o limite de 24 consecutivos.
      if (calls === 21) return { isComplete: false }
      if (calls <= 20 || (calls >= 22 && calls <= 41)) {
        throw new Error('Console HTTP 503: {"error":{"code":"UNAVAILABLE","message":"Gateway connection closed"}}')
      }
      return { isComplete: true, lastResponse: 'ok' }
    })

    expect(result.success).toBe(true)
    expect(result.data?.response).toBe('ok')
    expect(calls).toBe(42)
  })

  it('mantém a falha terminal quando a sessão reporta isFailed', async () => {
    const result = await wait(async () => ({ isFailed: true, error: 'Run falhou: modelo indisponível' }))

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Run falhou/)
  })
})
