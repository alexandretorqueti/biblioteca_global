// @vitest-environment node
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Lock de instalação do worktree (incidente task-p2-1047 / subtarefa 1441):
 * o lock via mkdir não tinha recuperação de lock órfão. Quando o detentor
 * morria (troca de container no deploy blue-green durante um `npm ci`), o
 * diretório `.motor-v3-npm-install.lock` ficava para sempre e toda execução
 * seguinte do worktree falhava com "Timeout aguardando lock de instalação".
 *
 * Comportamento esperado:
 * - Detentor vivo faz heartbeat no mtime do lock e o libera no finally.
 * - Lock sem heartbeat além do limiar de stale é retomado atomicamente
 *   (rename) por quem aguarda, sem corromper a exclusividade mútua.
 * - Lock fresco NÃO é retomado: quem aguarda segue em polling até o timeout.
 */

const LOCK_DIR = '.motor-v3-npm-install.lock'
const ENV_KEYS = [
  'MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS',
  'MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS',
  'MOTOR_TEST_GATE_INSTALL_LOCK_STALE_MS',
  'MOTOR_TEST_GATE_INSTALL_LOCK_HEARTBEAT_MS',
] as const

const savedEnv: Record<string, string | undefined> = {}
let workspaces: string[] = []

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'motor-install-lock-'))
  workspaces.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-ws', version: '1.0.0' }))
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'fixture-ws', lockfileVersion: 3 }))
  return dir
}

async function importPreparer() {
  vi.resetModules()
  const mod = await import('../src/testing/WorkspaceEnvironmentPreparer.js')
  return mod.WorkspaceEnvironmentPreparer
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await Promise.all(workspaces.map(dir => rm(dir, { recursive: true, force: true })))
  workspaces = []
})

describe('WorkspaceEnvironmentPreparer — lock de instalação', () => {
  it('retoma lock órfão (stale) e conclui a instalação', async () => {
    const ws = await makeWorkspace()
    const lockPath = join(ws, LOCK_DIR)
    await mkdir(lockPath)
    // Simula detentor morto: último heartbeat há 10 minutos (stale default = 2 min).
    const past = new Date(Date.now() - 10 * 60_000)
    await utimes(lockPath, past, past)

    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '20'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '10000'
    const installs: string[] = []
    const preparer = new (await importPreparer())(async directory => {
      installs.push(directory)
    })

    const prepared = await preparer.prepare(ws)

    expect(prepared).toEqual(['.'])
    expect(installs).toHaveLength(1)
    const remaining = await readdir(ws)
    expect(remaining).not.toContain(LOCK_DIR)
    expect(remaining.some(entry => entry.startsWith(`${LOCK_DIR}.stale-`))).toBe(false)
  })

  it('não retoma lock fresco e falha por timeout enquanto o detentor estiver vivo', async () => {
    const ws = await makeWorkspace()
    const lockPath = join(ws, LOCK_DIR)
    await mkdir(lockPath) // mtime = agora → fresco

    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '25'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '300'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_STALE_MS = '600000'
    const install = vi.fn(async () => {})
    const preparer = new (await importPreparer())(install)

    await expect(preparer.prepare(ws)).rejects.toThrow(/Timeout aguardando lock de instalação/)
    expect(install).not.toHaveBeenCalled()
    // O lock do detentor vivo precisa permanecer intacto.
    const remaining = await readdir(ws)
    expect(remaining).toContain(LOCK_DIR)
  })

  it('libera o lock mesmo quando a instalação falha', async () => {
    const ws = await makeWorkspace()
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '20'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '10000'
    const preparer = new (await importPreparer())(async () => {
      throw new Error('npm ci explodiu')
    })

    await expect(preparer.prepare(ws)).rejects.toThrow('npm ci explodiu')
    const remaining = await readdir(ws)
    expect(remaining).not.toContain(LOCK_DIR)
  })

  it('segundo executor aguarda o detentor vivo liberar o lock (sem takeover indevido)', async () => {
    const ws = await makeWorkspace()
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '20'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '10000'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_STALE_MS = '600000'

    const events: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstHolding = new Promise<void>(resolveRelease => {
      releaseFirst = resolveRelease
    })
    const Preparer = await importPreparer()
    const holder = new Preparer(async () => {
      events.push('holder-start')
      await firstHolding
      events.push('holder-end')
    })
    const waiter = new Preparer(async () => {
      events.push('waiter-run')
    })

    const holderPromise = holder.prepare(ws)
    // Garante que o holder adquiriu o lock antes do waiter tentar.
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    const waiterPromise = waiter.prepare(ws)
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    expect(events).toEqual(['holder-start']) // waiter ainda bloqueado

    releaseFirst!()
    await Promise.all([holderPromise, waiterPromise])

    expect(events).toEqual(['holder-start', 'holder-end', 'waiter-run'])
    const remaining = await readdir(ws)
    expect(remaining).not.toContain(LOCK_DIR)
  })
})
