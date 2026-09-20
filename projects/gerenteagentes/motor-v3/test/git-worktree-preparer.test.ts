import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitWorktreePreparer } from '../src/execution/GitWorktreePreparer.js'

const execFileAsync = promisify(execFile)

describe('GitWorktreePreparer', () => {
  it('cria worktree e branch isolados sem trocar o checkout da base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-worktree-test-'))
    const repo = join(root, 'repo')
    const worktrees = join(root, 'worktrees')
    await execFileAsync('git', ['init', '-b', 'base-desenvolvimento', repo])
    await execFileAsync('git', ['config', 'user.email', 'motor@example.test'], { cwd: repo })
    await execFileAsync('git', ['config', 'user.name', 'Motor Test'], { cwd: repo })
    await import('node:fs/promises').then(fs => fs.writeFile(join(repo, 'README.md'), 'base\n'))
    await execFileAsync('git', ['add', 'README.md'], { cwd: repo })
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo })

    const prepared = await new GitWorktreePreparer(worktrees).prepare({
      taskId: 'task-p6-845', subtaskId: 901, repoPath: repo, baseBranch: 'base-desenvolvimento',
    })

    expect(prepared.branch).toBe('motor-v3/subtask-task-p6-845-901-a1')
    expect(await readFile(join(prepared.path, 'README.md'), 'utf8')).toBe('base\n')
    expect((await execFileAsync('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()).toBe('base-desenvolvimento')
    expect((await execFileAsync('git', ['branch', '--show-current'], { cwd: prepared.path })).stdout.trim()).toBe(prepared.branch)
  })
})
