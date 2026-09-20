import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitVerificationIntegrator } from '../src/execution/GitVerificationIntegrator.js'
import { GitWorktreePreparer } from '../src/execution/GitWorktreePreparer.js'

const execFileAsync = promisify(execFile)

describe('GitVerificationIntegrator', () => {
  it('commita a subtarefa e integra por cherry-pick sem alterar a branch base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-integrator-test-'))
    const repo = join(root, 'repo')
    const preparer = new GitWorktreePreparer(join(root, 'worktrees'))
    await execFileAsync('git', ['init', '-b', 'base-desenvolvimento', repo])
    await execFileAsync('git', ['config', 'user.email', 'motor@example.test'], { cwd: repo })
    await execFileAsync('git', ['config', 'user.name', 'Motor Test'], { cwd: repo })
    await writeFile(join(repo, 'README.md'), 'base\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: repo })
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo })
    const workspace = await preparer.prepare({ taskId: 'task-1', subtaskId: 10, repoPath: repo, baseBranch: 'base-desenvolvimento' })
    await writeFile(join(workspace.path, 'README.md'), 'alterado\n')

    const context = {
      taskId: 'task-1', databaseTaskId: 1, subtaskId: 10, seq: 1,
      taskTitle: 'T', taskDescription: '', title: 'S', scope: '', acceptanceCriteria: [], deliverables: [],
      projectSlug: 'p', repoPath: repo, baseBranch: 'base-desenvolvimento', buildCommand: 'true', testCommand: 'true',
      agentId: 'a', workspacePath: workspace.path, workspaceBranch: workspace.branch, workspaceBaseCommit: workspace.baseCommit,
    }
    const integrator = new GitVerificationIntegrator(preparer)
    const result = await integrator.verifyAndIntegrate(context)
    const retried = await integrator.verifyAndIntegrate(context)

    const integration = await preparer.prepareIntegration({ taskId: 'task-1', repoPath: repo, baseBranch: 'base-desenvolvimento' })
    expect(await readFile(join(integration.path, 'README.md'), 'utf8')).toBe('alterado\n')
    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/)
    expect(result.integrationCommitSha).toMatch(/^[a-f0-9]{40}$/)
    expect(retried).toEqual(result)
    expect((await execFileAsync('git', ['branch', '--show-current'], { cwd: repo })).stdout.trim()).toBe('base-desenvolvimento')
  })
})
