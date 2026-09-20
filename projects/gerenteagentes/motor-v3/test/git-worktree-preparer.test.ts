import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitWorktreePreparer, mapHostRepoPathToContainer } from '../src/execution/GitWorktreePreparer.js'

const execFileAsync = promisify(execFile)
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('GitWorktreePreparer', () => {
  it('normaliza caminho persistido no host para o bind da API', () => {
    expect(mapHostRepoPathToContainer('/home/alexandre/codigofonte/biblioteca-global')).toBe(
      '/data/workspace/projects/codigofonte/biblioteca-global',
    )
  })

  it('cria worktrees sem alterar o checkout base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-worktree-'))
    temporaryPaths.push(root)
    const repository = join(root, 'repo')
    const worktrees = join(root, 'worktrees')
    await execFileAsync('git', ['init', '-b', 'base-desenvolvimento', repository])
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.name', 'Motor v3 test'], { cwd: repository })
    await writeFile(join(repository, 'README.md'), 'base\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: repository })
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repository })

    const preparer = new GitWorktreePreparer(worktrees)
    const prepared = await preparer.prepare({
      taskId: 'task-1', subtaskId: 10, repoPath: repository, baseBranch: 'base-desenvolvimento',
    })

    expect(prepared.branch).toBe('motor-v3-work/subtask-task-1-10-a1')
    await expect(execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: prepared.path })).resolves.toBeDefined()
    await expect(execFileAsync('git', ['status', '--porcelain'], { cwd: repository })).resolves.toMatchObject({ stdout: '' })
  })

  it('falha com motivo explícito quando o repositório não é visível no container', async () => {
    const preparer = new GitWorktreePreparer('/tmp/motor-v3-worktrees')
    await expect(preparer.prepare({
      taskId: 'task-1', subtaskId: 10, repoPath: '/home/alexandre/codigofonte/inexistente', baseBranch: 'base-desenvolvimento',
    })).rejects.toThrow('Repositório inacessível no container do Motor')
  })
})
