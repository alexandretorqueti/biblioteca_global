import { execFile, execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// A lib usa `curl` por contrato. O gate de testes herda o env do container do
// motor, que pode não ter curl instalado — nesse caso os testes HTTP são
// pulados (skip explícito, nunca falha espúria). Testes que não fazem HTTP
// continuam rodando em qualquer ambiente.
const hasCurl = (() => {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// Resolve a partir da localização deste teste (motor-v3/test) — não do cwd,
// que varia conforme o workspace onde o vitest é invocado.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS_DIR = resolve(PKG_ROOT, '..', 'scripts')
const LIB_PATH = resolve(SCRIPTS_DIR, 'lib/deploy-callback.sh')
const MAIN_SCRIPT = resolve(SCRIPTS_DIR, 'deploy-blue-green.sh')

interface StubState {
  calls: Array<{ port: number; auth: string; body: string }>
  /** portas que respondem 202; as demais respondem 503 (retryable) */
  healthy: Set<number>
}

function startStub(stub: StubState): Promise<Server> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const port = Number((server.address() as { port: number }).port)
      stub.calls.push({ port, auth: String(req.headers['x-motor-deploy-token'] ?? ''), body })
      if (stub.healthy.has(port)) {
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: true }))
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Outbox indisponível' }))
      }
    })
  })
  return new Promise(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen(server)))
}

async function runLib(options: {
  ports: number[]
  preferred?: string
  rounds?: number
  callbackSecret?: string
  batchId?: string
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const secret = options.callbackSecret ?? 'sekret'
  const driver = [
    'set -euo pipefail',
    `DEPLOY_BATCH_ID=${options.batchId ?? 'batch-test'}`,
    `MOTOR_DEPLOY_CALLBACK_TOKEN=${secret}`,
    `MOTOR_DEPLOY_CALLBACK_PORTS="${options.ports.join(' ')}"`,
    `MOTOR_DEPLOY_CALLBACK_ROUNDS=${options.rounds ?? 2}`,
    'MOTOR_DEPLOY_CALLBACK_RETRY_DELAY_SECONDS=0',
    'source "$LIB_PATH"',
    `notify_motor_deploy_result success "" "${options.preferred ?? ''}"`,
  ].join('\n')
  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', driver], {
      env: { ...process.env, LIB_PATH },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string }
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('retry dual-porta do callback (lib deploy-callback.sh)', () => {
  const openServers: Server[] = []

  afterAll(async () => {
    await Promise.all(openServers.map(s => new Promise<void>(r => s.close(() => r()))))
  })

  it('a lib existe e é carregável; o script principal a sourceia e mantém o trap best-effort', () => {
    expect(existsSync(LIB_PATH)).toBe(true)
    const main = readFileSync(MAIN_SCRIPT, 'utf8')
    expect(main).toContain('scripts/lib/deploy-callback.sh')
    expect(main).toContain('notify_motor_deploy_result')
    expect(main).toMatch(/notify_deploy_result "\$status" "\$callback_port" \|\|/)
  })

  it.skipIf(!hasCurl)('líder alternou: porta preferida em 503 → round visita a segunda e é aceito', async () => {
    const down: StubState = { calls: [], healthy: new Set() }
    const up: StubState = { calls: [], healthy: new Set() }
    const sDown = await startStub(down)
    const sUp = await startStub(up)
    openServers.push(sDown, sUp)
    const pDown = (sDown.address() as { port: number }).port
    const pUp = (sUp.address() as { port: number }).port
    up.healthy.add(pUp)

    const result = await runLib({ ports: [pDown, pUp], preferred: String(pDown), rounds: 2 })

    expect(result.code).toBe(0)
    // primeira porta tentada primeiro e recusada (503), segunda aceita.
    expect(down.calls).toHaveLength(1)
    expect(up.calls).toHaveLength(1)
    expect(up.calls[0]).toMatchObject({ port: pUp, auth: 'sekret', body: '{"status":"success"}' })
  })

  it.skipIf(!hasCurl)('503 em ambas → rounds inteiros (503 é retryable) e desfecho best-effort limitado', async () => {
    const a: StubState = { calls: [], healthy: new Set() }
    const b: StubState = { calls: [], healthy: new Set() }
    const sA = await startStub(a)
    const sB = await startStub(b)
    openServers.push(sA, sB)
    const pA = (sA.address() as { port: number }).port
    const pB = (sB.address() as { port: number }).port

    const result = await runLib({ ports: [pA, pB], rounds: 3 })

    // Esgota rounds e retorna 1 sem travar — nunca "ok" sem 2xx.
    expect(result.code).toBe(1)
    expect(a.calls).toHaveLength(3) // cada round visita cada porta
    expect(b.calls).toHaveLength(3)
    expect(result.stderr).toContain('HTTP 503')
  })

  it.skipIf(!hasCurl)('líder na primeira porta → 202 imediato sem alternar', async () => {
    const a: StubState = { calls: [], healthy: new Set() }
    const b: StubState = { calls: [], healthy: new Set() }
    const sA = await startStub(a)
    const sB = await startStub(b)
    openServers.push(sA, sB)
    const pA = (sA.address() as { port: number }).port
    const pB = (sB.address() as { port: number }).port
    a.healthy.add(pA)

    const result = await runLib({ ports: [pA, pB], rounds: 3 })

    expect(result.code).toBe(0)
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(0)
  })

  it('sem segredo de callback → recusa imediata (1) sem chamadas HTTP; sem batch → sucesso silencioso (0)', async () => {
    const a: StubState = { calls: [], healthy: new Set() }
    const sA = await startStub(a)
    openServers.push(sA)
    const pA = (sA.address() as { port: number }).port

    const noCallbackSecret = await runLib({ ports: [pA], callbackSecret: '' })
    expect(noCallbackSecret.code).toBe(1)
    expect(a.calls).toHaveLength(0)

    const noBatch = await runLib({ ports: [pA], batchId: '' })
    expect(noBatch.code).toBe(0)
    expect(a.calls).toHaveLength(0)
  })
})
