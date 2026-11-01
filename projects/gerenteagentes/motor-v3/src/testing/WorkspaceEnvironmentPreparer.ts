import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const INSTALL_LOCK_DIRECTORY = '.motor-v3-npm-install.lock'
const INSTALL_LOCK_OWNER_FILE = 'owner.json'
const INSTALL_LOCK_STALE_PREFIX = `${INSTALL_LOCK_DIRECTORY}.stale-`
const INSTALL_LOCK_POLL_MS = Number(process.env.MOTOR_TEST_GATE_INSTALL_LOCK_POLL_MS || 250)
const INSTALL_LOCK_TIMEOUT_MS = Number(process.env.MOTOR_TEST_GATE_INSTALL_LOCK_TIMEOUT_MS || 900_000)
const INSTALL_LOCK_STALE_MS = Number(process.env.MOTOR_TEST_GATE_INSTALL_LOCK_STALE_MS || 120_000)
const INSTALL_LOCK_HEARTBEAT_MS = Number(process.env.MOTOR_TEST_GATE_INSTALL_LOCK_HEARTBEAT_MS || 15_000)

async function wait(milliseconds: number): Promise<void> {
  await new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}

/** Identidade do detentor do lock, gravada em `owner.json` dentro do diretório do lock. */
export interface InstallLockOwner {
  pid: number
  hostname: string
  acquiredAt: string
  heartbeatAt: string
}

/** Eventos estruturados do ciclo de vida do lock de instalação. */
export type InstallLockEvent =
  | { event: 'lock_acquired'; lockPath: string; owner: InstallLockOwner }
  | { event: 'lock_stale_reclaimed'; lockPath: string; reason: 'dead_pid' | 'stale_heartbeat'; ageMs: number; owner: InstallLockOwner | null }
  | { event: 'lock_takeover_failed'; lockPath: string; reason: string; owner: InstallLockOwner | null }

/**
 * Logger estruturado injetável para eventos do lock de instalação.
 * Mesmo padrão de logger opcional usado em `motor-v3/src/testing/`
 * (ex.: `OperationLogger` no `TestGateConsumer`): quem constrói injeta;
 * o padrão é compatível com console (linha JSON via `console.info`).
 */
export interface InstallLockLogger {
  log(entry: InstallLockEvent): void | Promise<void>
}

export const consoleInstallLockLogger: InstallLockLogger = {
  log(entry: InstallLockEvent): void {
    console.info(JSON.stringify({ ts: new Date().toISOString(), scope: 'workspace-install-lock', ...entry }))
  },
}

/** Falha de log NUNCA pode quebrar o fluxo do lock. */
function emitLockEvent(logger: InstallLockLogger, entry: InstallLockEvent): void {
  try {
    void Promise.resolve(logger.log(entry)).catch(() => {})
  } catch {
    // logger síncrono que lançou: ignorar.
  }
}

/** `process.kill(pid, 0)` → ESRCH significa processo morto; EPERM significa vivo (de outro usuário). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Lê o owner.json do lock. Ausente/ilegível/incompleto degrada para `null`,
 * e a recuperação cai no critério de idade/heartbeat (comportamento anterior).
 */
async function readInstallLockOwner(lockPath: string): Promise<InstallLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(lockPath, INSTALL_LOCK_OWNER_FILE), 'utf8')) as Partial<InstallLockOwner>
    if (typeof parsed?.pid !== 'number' || !Number.isFinite(parsed.pid) || typeof parsed?.hostname !== 'string') return null
    return {
      pid: parsed.pid,
      hostname: parsed.hostname,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : '',
      heartbeatAt: typeof parsed.heartbeatAt === 'string' ? parsed.heartbeatAt : '',
    }
  } catch {
    return null
  }
}

/** Grava o owner.json sem nunca quebrar o fluxo (lock sem owner ainda degrada para idade). */
async function writeInstallLockOwner(ownerPath: string, owner: InstallLockOwner): Promise<void> {
  try {
    await writeFile(ownerPath, JSON.stringify(owner))
  } catch {
    // owner.json é sinal auxiliar; a ausência dele não invalida o lock.
  }
}

/** Varre resíduos `.stale-*` deixados por retomadas anteriores (rm pós-rename que falhou). Idempotente. */
async function sweepStaleLockResidues(workspacePath: string): Promise<void> {
  try {
    const entries = await readdir(workspacePath)
    await Promise.all(
      entries
        .filter(entry => entry.startsWith(INSTALL_LOCK_STALE_PREFIX))
        .map(entry => rm(resolve(workspacePath, entry), { recursive: true, force: true })),
    )
  } catch {
    // Varredura é melhor esforço: não pode falhar a preparação.
  }
}

/**
 * Retoma um lock órfão: se o detentor morreu (troca de container no deploy
 * blue-green, crash, SIGKILL), o diretório do lock permanece e bloquearia o
 * worktree para sempre — todo attempt seguinte morreria em timeout.
 *
 * Critérios de órfão (nessa ordem):
 * 1. **PID morto no mesmo host:** `owner.json` com hostname local e
 *    `process.kill(pid, 0)` → ESRCH autoriza retomada IMEDIATA (sem esperar
 *    o limiar de idade).
 * 2. **Idade/heartbeat:** PID vivo no mesmo host OU owner de outro host
 *    (containers blue/green compartilham o filesystem — PID externo não é
 *    verificável) OU owner.json ausente/ilegível caem no critério de idade:
 *    lock sem heartbeat há mais de INSTALL_LOCK_STALE_MS é órfão.
 *
 * Lock fresco/detentor vivo NUNCA é removido. A retomada é via rename atômico
 * (apenas um concorrente vence o rename; os demais caem no catch e seguem o
 * polling normal), seguida de rm; se o rm falhar, o resíduo `.stale-*` é
 * varrido de forma idempotente.
 */
async function reclaimStaleInstallLock(lockPath: string, workspacePath: string, logger: InstallLockLogger): Promise<void> {
  let ageMs = 0
  let owner: InstallLockOwner | null = null
  try {
    const stats = await stat(lockPath)
    ageMs = Date.now() - stats.mtimeMs
  } catch {
    // Lock recém-removido/renomeado por outro concorrente: nada a fazer.
    return
  }
  owner = await readInstallLockOwner(lockPath)
  const deadPid = owner !== null && owner.hostname === hostname() && !isProcessAlive(owner.pid)
  if (!deadPid && ageMs <= INSTALL_LOCK_STALE_MS) return
  const reason: 'dead_pid' | 'stale_heartbeat' = deadPid ? 'dead_pid' : 'stale_heartbeat'
  const takeoverPath = `${lockPath}.stale-${process.pid}-${Date.now()}`
  try {
    await rename(lockPath, takeoverPath)
  } catch (error) {
    // Perda de corrida para outro concorrente (ENOENT) ou lock ainda protegido:
    // o polling continua.
    emitLockEvent(logger, {
      event: 'lock_takeover_failed',
      lockPath,
      reason: (error as NodeJS.ErrnoException)?.code ?? String(error),
      owner,
    })
    return
  }
  emitLockEvent(logger, { event: 'lock_stale_reclaimed', lockPath, reason, ageMs, owner })
  try {
    await rm(takeoverPath, { recursive: true, force: true })
  } catch {
    // rm falhou após o rename: varre o resíduo para não acumular `.stale-*`.
    await sweepStaleLockResidues(workspacePath)
  }
}

/**
 * `npm ci` não tolera duas instalações no mesmo worktree: ambas removem e
 * recriam os links dos workspaces e uma delas termina com EEXIST. O lock usa
 * mkdir (atômico no filesystem compartilhado) para coordenar inclusive os
 * dois processos blue/green do Motor. O detentor grava `owner.json` (PID/host)
 * dentro do lock e faz heartbeat periódico no mtime do lock e no heartbeatAt
 * do owner para que locks órfãos (detentor morto) possam ser detectados
 * (PID morto → imediato; senão por idade) e retomados com segurança.
 */
async function withWorkspaceInstallLock<T>(
  workspacePath: string,
  operation: () => Promise<T>,
  logger: InstallLockLogger = consoleInstallLockLogger,
): Promise<T> {
  const lockPath = resolve(workspacePath, INSTALL_LOCK_DIRECTORY)
  const ownerPath = join(lockPath, INSTALL_LOCK_OWNER_FILE)
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS
  while (true) {
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new Error(`Timeout aguardando lock de instalação do worktree: ${lockPath}`, { cause: error })
      }
      await reclaimStaleInstallLock(lockPath, workspacePath, logger)
      await wait(INSTALL_LOCK_POLL_MS)
    }
  }
  const acquiredAt = new Date().toISOString()
  const owner: InstallLockOwner = { pid: process.pid, hostname: hostname(), acquiredAt, heartbeatAt: acquiredAt }
  await writeInstallLockOwner(ownerPath, owner)
  emitLockEvent(logger, { event: 'lock_acquired', lockPath, owner })
  // Varredura idempotente de resíduos `.stale-*` de retomadas anteriores.
  await sweepStaleLockResidues(workspacePath)
  const heartbeat = setInterval(() => {
    const now = new Date()
    utimes(lockPath, now, now).catch(() => {})
    void writeInstallLockOwner(ownerPath, { ...owner, heartbeatAt: now.toISOString() })
  }, INSTALL_LOCK_HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await rm(lockPath, { recursive: true, force: true })
  }
}

/**
 * Verifica se o diretório git tem modificações locais que podem causar
 * falha no npm ci (package.json ou package-lock.json modificados).
 * Se houver, faz git checkout para limpar.
 */
async function ensureCleanWorkspace(directory: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: directory,
      timeout: 10_000,
    })
    const changes = stdout.trim()
    if (!changes) return

    // Verifica se há mudanças em package.json ou package-lock.json
    const hasPackageChanges = changes.split('\n').some(line => {
      const file = line.slice(3).trim()
      return file === 'package.json' || file === 'package-lock.json'
    })

    if (hasPackageChanges) {
      // Limpa modificações locais para evitar dessincronização no npm ci
      await execFileAsync('git', ['checkout', '--', 'package.json', 'package-lock.json'], {
        cwd: directory,
        timeout: 10_000,
      })
    }
  } catch {
    // Se não for um repo git ou falhar, continua sem limpar
  }
}

/**
 * Materializa dependências de pacotes isolados que não pertencem aos
 * workspaces npm da raiz. O build configurado continua responsável pelo
 * `npm ci` da raiz e package-locks aninhados usados pelos testes do monorepo
 * (por exemplo, motor-v3). O Motor roda com NODE_ENV=production em
 * alguns ambientes, mas os gates exigem runners e tipos de devDependencies.
 */
export class WorkspaceEnvironmentPreparer {
  constructor(
    private readonly install: (directory: string) => Promise<void> = async directory => {
      await execFileAsync('npm', ['ci', '--include=dev', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error'], {
        cwd: directory,
        timeout: Number(process.env.MOTOR_TEST_GATE_INSTALL_TIMEOUT_MS || 900_000),
        maxBuffer: 50 * 1024 * 1024,
      })
    },
    private readonly installLockLogger: InstallLockLogger = consoleInstallLockLogger,
  ) {}

  async prepare(workspacePath: string): Promise<string[]> {
    return withWorkspaceInstallLock(workspacePath, async () => {
      const lockfiles = await this.findLockfiles(workspacePath)
      const prepared: string[] = []
      for (const lockfile of lockfiles) {
        const directory = dirname(lockfile)
        // Garante que o worktree está limpo antes de npm ci
        // (modificações locais em package.json/lock causam EUSAGE)
        await ensureCleanWorkspace(directory)
        await this.install(directory)
        prepared.push(relative(workspacePath, directory) || '.')
      }
      return prepared
    }, this.installLockLogger)
  }

  private async findLockfiles(workspacePath: string): Promise<string[]> {
    const root = resolve(workspacePath)
    const found: string[] = []
    await this.addLockfileIfPackage(root, found)
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 6) return
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('wt-')) continue
        const child = resolve(directory, entry.name)
        if (!(await this.addLockfileIfPackage(child, found))) {
          await visit(child, depth + 1)
        }
      }
    }
    await visit(root, 0)
    return found.sort()
  }

  private async addLockfileIfPackage(directory: string, found: string[]): Promise<boolean> {
    try {
      const packageJson = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as { name?: unknown }
      await readFile(resolve(directory, 'package-lock.json'))
      if (typeof packageJson.name === 'string') found.push(resolve(directory, 'package-lock.json'))
      return true
    } catch {
      return false
    }
  }
}
