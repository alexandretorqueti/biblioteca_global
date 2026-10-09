import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
  ) {}

  async prepare(workspacePath: string): Promise<string[]> {
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
