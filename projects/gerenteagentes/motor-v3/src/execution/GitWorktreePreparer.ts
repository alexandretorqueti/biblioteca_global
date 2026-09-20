import { execFile } from 'node:child_process'
import { access, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface PreparedWorktree {
  path: string
  branch: string
  baseCommit: string
}

export function mapHostRepoPathToContainer(repoPath: string): string | null {
  const original = resolve(repoPath)
  const hostPrefix = '/home/alexandre/codigofonte/'
  const containerPrefix = '/data/workspace/projects/codigofonte/'
  if (!original.startsWith(hostPrefix)) return null
  return resolve(containerPrefix, original.slice(hostPrefix.length))
}

/** Prepara um worktree isolado sem alterar o checkout da branch base. */
export class GitWorktreePreparer {
  constructor(private readonly root: string) {}

  async prepare(input: { taskId: string; subtaskId: number; repoPath: string; baseBranch: string }): Promise<PreparedWorktree> {
    if (!input.repoPath || !input.baseBranch) throw new Error('Projeto sem repo_path ou branch_trabalho configurados')
    const repoPath = await this.resolveRepoPath(input.repoPath)
    await this.assertGitAvailable()
    const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, '-')
    const taskBranch = `motor-v3/integration-${safeTaskId}`
    await this.prepareNamedWorktree(repoPath, input.baseBranch, taskBranch, resolve(this.root, safeTaskId, 'integration'))
    const branch = `motor-v3/subtask-${safeTaskId}-${input.subtaskId}-a1`
    const path = resolve(this.root, safeTaskId, String(input.subtaskId), 'a1')
    await mkdir(dirname(path), { recursive: true })

    if (await this.exists(path)) {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path })
      return { path, branch, baseCommit: stdout.trim() }
    }

    const { stdout } = await execFileAsync('git', ['rev-parse', taskBranch], { cwd: repoPath })
    const baseCommit = stdout.trim()
    await execFileAsync('git', ['worktree', 'add', '-b', branch, path, baseCommit], { cwd: repoPath })
    return { path, branch, baseCommit }
  }

  async prepareIntegration(input: { taskId: string; repoPath: string; baseBranch: string }): Promise<PreparedWorktree> {
    const repoPath = await this.resolveRepoPath(input.repoPath)
    await this.assertGitAvailable()
    const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, '-')
    const branch = `motor-v3/integration-${safeTaskId}`
    const path = resolve(this.root, safeTaskId, 'integration')
    const baseCommit = await this.prepareNamedWorktree(repoPath, input.baseBranch, branch, path)
    return { path, branch, baseCommit }
  }

  private async prepareNamedWorktree(repoPath: string, baseRef: string, branch: string, path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true })
    if (await this.exists(path)) {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path })
      return stdout.trim()
    }
    const branchExists = await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })
      .then(() => true, () => false)
    if (branchExists) {
      await execFileAsync('git', ['worktree', 'add', path, branch], { cwd: repoPath })
    } else {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, path, baseRef], { cwd: repoPath })
    }
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path })
    return stdout.trim()
  }

  private async exists(path: string): Promise<boolean> {
    try { await stat(path); return true } catch { return false }
  }

  /** Converte o caminho persistido pelo host para o bind visível na API. */
  private async resolveRepoPath(repoPath: string): Promise<string> {
    const original = resolve(repoPath)
    if (await this.exists(original)) return original
    const mapped = mapHostRepoPathToContainer(original)
    if (mapped && await this.exists(mapped)) return mapped
    throw new Error(`Repositório inacessível no container do Motor: ${original}`)
  }

  private async assertGitAvailable(): Promise<void> {
    try {
      await access('/usr/bin/git')
    } catch {
      try {
        await execFileAsync('git', ['--version'])
      } catch {
        throw new Error('Ambiente do Motor sem executável git; reconstrua a imagem da API com git instalado')
      }
    }
  }
}
