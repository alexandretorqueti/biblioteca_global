// @vitest-environment node
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
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
const OWNER_FILE = 'owner.json'
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

/** Localiza um PID inexistente (ESRCH) para simular detentor morto. */
function findDeadPid(): number {
  for (let pid = process.pid + 1; pid < process.pid + 200_000; pid++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('não foi encontrado um PID morto para o teste')
}

async function writeOwner(lockPath: string, owner: Record<string, unknown>): Promise<void> {
  await writeFile(join(lockPath, OWNER_FILE), JSON.stringify(owner))
}

function collectingLogger() {
  const entries: Array<Record<string, unknown>> = []
  return { entries, logger: { log: (entry: Record<string, unknown>) => { entries.push(entry) } } }
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

describe('WorkspaceEnvironmentPreparer — lock com proprietário (owner.json)', () => {
  it('retoma imediatamente lock cujo owner tem PID morto no mesmo host (sem esperar idade stale)', async () => {
    const ws = await makeWorkspace()
    const lockPath = join(ws, LOCK_DIR)
    await mkdir(lockPath)
    // Lock FRESCO (idade não autorizaria retomada: stale = 10 min) mas o
    // owner.json aponta um PID morto no host atual → retomada imediata.
    const deadPid = findDeadPid()
    await writeOwner(lockPath, {
      pid: deadPid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })

    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '20'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '5000'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_STALE_MS = '600000'
    const { entries, logger } = collectingLogger()
    const install = vi.fn(async () => {})
    const preparer = new (await importPreparer())(install, logger)

    const prepared = await preparer.prepare(ws)

    expect(prepared).toEqual(['.'])
    expect(install).toHaveBeenCalledTimes(1)
    const reclaimed = entries.find(entry => entry.event === 'lock_stale_reclaimed')
    expect(reclaimed).toBeDefined()
    expect(reclaimed!.reason).toBe('dead_pid')
    expect((reclaimed!.owner as Record<string, unknown>)?.pid).toBe(deadPid)
    const remaining = await readdir(ws)
    expect(remaining).not.toContain(LOCK_DIR)
  })

  it('não retoma lock com PID vivo no mesmo host mesmo com heartbeat antigo limítrofe', async () => {
    const ws = await makeWorkspace()
    const lockPath = join(ws, LOCK_DIR)
    await mkdir(lockPath)
    // Heartbeat "limítrofe": 59s de idade com stale = 60s → abaixo do limiar.
    await writeOwner(lockPath, {
      pid: process.pid, // vivo
      hostname: hostname(),
      acquiredAt: new Date(Date.now() - 59_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 59_000).toISOString(),
    })
    const past = new Date(Date.now() - 59_000)
    await utimes(lockPath, past, past)

    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '25'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '300'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_STALE_MS = '60000'
    const install = vi.fn(async () => {})
    const preparer = new (await importPreparer())(install, collectingLogger().logger)

    await expect(preparer.prepare(ws)).rejects.toThrow(/Timeout aguardando lock de instalação/)
    expect(install).not.toHaveBeenCalled()
    const remaining = await readdir(ws)
    expect(remaining).toContain(LOCK_DIR)
    // O owner.json do detentor vivo permanece intacto.
    const owner = JSON.parse(await readFile(join(lockPath, OWNER_FILE), 'utf8')) as { pid: number }
    expect(owner.pid).toBe(process.pid)
  })

  it('não retoma lock de outro host com heartbeat fresco (PID externo não é verificável)', async () => {
    const ws = await makeWorkspace()
    const lockPath = join(ws, LOCK_DIR)
    await mkdir(lockPath)
    await writeOwner(lockPath, {
      pid: 424242,
      hostname: 'outro-container-blue-green',
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })

    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '25'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '300'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_STALE_MS = '600000'
    const install = vi.fn(async () => {})
    const preparer = new (await importPreparer())(install, collectingLogger().logger)

    await expect(preparer.prepare(ws)).rejects.toThrow(/Timeout aguardando lock de instalação/)
    expect(install).not.toHaveBeenCalled()
    expect(await readdir(ws)).toContain(LOCK_DIR)
  })

  it('owner.json ilegível degrada com segurança para o critério de idade (stale → retomado)', async () => {
    const ws = await makeWorkspace()
    const lockPath = join(ws, LOCK_DIR)
    await mkdir(lockPath)
    await writeFile(join(lockPath, OWNER_FILE), '{"pid": "QUEBRADO"')
    const past = new Date(Date.now() - 10 * 60_000)
    await utimes(lockPath, past, past)

    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '20'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '5000'
    const { entries, logger } = collectingLogger()
    const install = vi.fn(async () => {})
    const preparer = new (await importPreparer())(install, logger)

    await expect(preparer.prepare(ws)).resolves.toEqual(['.'])
    const reclaimed = entries.find(entry => entry.event === 'lock_stale_reclaimed')
    expect(reclaimed).toBeDefined()
    expect(reclaimed!.reason).toBe('stale_heartbeat')
    expect(reclaimed!.owner).toBeNull()
  })

  it('grava owner.json na aquisição (pid/host/timestamps) e o heartbeat atualiza heartbeatAt', async () => {
    const ws = await makeWorkspace()
    const lockPath = join(ws, LOCK_DIR)
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '20'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '5000'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_HEARTBEAT_MS = '30'
    const { entries, logger } = collectingLogger()
    let duringOperation: { pid: number; hostname: string; acquiredAt: string; heartbeatAt: string } | undefined
    let afterHeartbeats: { heartbeatAt: string } | undefined
    const preparer = new (await importPreparer())(async () => {
      duringOperation = JSON.parse(await readFile(join(lockPath, OWNER_FILE), 'utf8'))
      await new Promise(resolveWait => setTimeout(resolveWait, 150))
      afterHeartbeats = JSON.parse(await readFile(join(lockPath, OWNER_FILE), 'utf8'))
    }, logger)

    await preparer.prepare(ws)

    expect(duringOperation).toBeDefined()
    expect(duringOperation!.pid).toBe(process.pid)
    expect(duringOperation!.hostname).toBe(hostname())
    expect(duringOperation!.acquiredAt).toBeTruthy()
    expect(afterHeartbeats).toBeDefined()
    expect(afterHeartbeats!.heartbeatAt).not.toBe(duringOperation!.heartbeatAt)
    const acquired = entries.find(entry => entry.event === 'lock_acquired')
    expect(acquired).toBeDefined()
    expect((acquired!.owner as Record<string, unknown>).pid).toBe(process.pid)
    expect((acquired!.owner as Record<string, unknown>).hostname).toBe(hostname())
    // Após a liberação, o lock (e o owner.json dentro dele) não permanecem.
    expect(await readdir(ws)).not.toContain(LOCK_DIR)
  })

  it('varre resíduos .stale-* idempotentemente na aquisição', async () => {
    const ws = await makeWorkspace()
    await mkdir(join(ws, `${LOCK_DIR}.stale-999-1700000000000`))
    await mkdir(join(ws, `${LOCK_DIR}.stale-888-1700000000001`, 'node_modules'), { recursive: true })

    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '20'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '5000'
    const preparer = new (await importPreparer())(async () => {}, collectingLogger().logger)

    await expect(preparer.prepare(ws)).resolves.toEqual(['.'])
    const remaining = await readdir(ws)
    expect(remaining.some(entry => entry.startsWith(`${LOCK_DIR}.stale-`))).toBe(false)
  })

  it('logger que lança não quebra a preparação (falha de log é engolida)', async () => {
    const ws = await makeWorkspace()
    const lockPath = join(ws, LOCK_DIR)
    await mkdir(lockPath)
    const past = new Date(Date.now() - 10 * 60_000)
    await utimes(lockPath, past, past)

    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS = '20'
    process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS = '5000'
    const explodingLogger = {
      log: () => {
        throw new Error('logger explodiu')
      },
    }
    const preparer = new (await importPreparer())(async () => {}, explodingLogger)

    await expect(preparer.prepare(ws)).resolves.toEqual(['.'])
  })
})
