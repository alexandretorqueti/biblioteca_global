import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Materializa dependências de pacotes isolados que não pertencem aos
 * workspaces npm da raiz. O build configurado continua responsável pelo
 * `npm ci` principal; aqui cobrimos package-locks aninhados usados pelos
 * testes do monorepo (por exemplo, motor-v2/motor-v3).
 */
export class WorkspaceEnvironmentPreparer {
  constructor(
    private readonly install: (directory: string) => Promise<void> = async directory => {
      await execFileAsync('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
        cwd: directory,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      })
    },
  ) {}

  async prepare(workspacePath: string): Promise<string[]> {
    const lockfiles = await this.findNestedLockfiles(workspacePath)
    const prepared: string[] = []
    for (const lockfile of lockfiles) {
      const directory = dirname(lockfile)
      await this.install(directory)
      prepared.push(relative(workspacePath, directory) || '.')
    }
    return prepared
  }

  private async findNestedLockfiles(workspacePath: string): Promise<string[]> {
    const root = resolve(workspacePath)
    const found: string[] = []
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 6) return
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('wt-')) continue
        const child = resolve(directory, entry.name)
        const lockfile = resolve(child, 'package-lock.json')
        try {
          const packageJson = JSON.parse(await readFile(resolve(child, 'package.json'), 'utf8')) as { name?: unknown }
          await readFile(lockfile)
          if (typeof packageJson.name === 'string') found.push(lockfile)
        } catch {
          await visit(child, depth + 1)
        }
      }
    }
    await visit(root, 0)
    return found.sort()
  }
}
