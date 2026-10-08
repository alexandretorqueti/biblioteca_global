import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
    const hooksPath = join(workspace.path, '.githooks')
    const preCommitHook = join(hooksPath, 'pre-commit')
    await mkdir(hooksPath)
    await writeFile(preCommitHook, '#!/bin/sh\nexit 1\n')
    await chmod(preCommitHook, 0o755)
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: workspace.path })

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

  it('rejeita no gate uma migration adicionada sem entrada no journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-integrator-journal-'))
    const repo = join(root, 'repo')
    const preparer = new GitWorktreePreparer(join(root, 'worktrees'))
    await execFileAsync('git', ['init', '-b', 'base-desenvolvimento', repo])
    await execFileAsync('git', ['config', 'user.email', 'motor@example.test'], { cwd: repo })
    await execFileAsync('git', ['config', 'user.name', 'Motor Test'], { cwd: repo })
    await mkdir(join(repo, 'projects/alpha/migrations/meta'), { recursive: true })
    await writeFile(join(repo, 'projects/alpha/migrations/meta/_journal.json'), JSON.stringify({ entries: [] }))
    await execFileAsync('git', ['add', '.'], { cwd: repo })
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo })
    const workspace = await preparer.prepare({ taskId: 'task-journal', subtaskId: 11, repoPath: repo, baseBranch: 'base-desenvolvimento' })
    await writeFile(join(workspace.path, 'projects/alpha/migrations/0001_orphan.sql'), '-- orphan')
    const context = {
      taskId: 'task-journal', databaseTaskId: 1, subtaskId: 11, seq: 1,
      taskTitle: 'T', taskDescription: '', title: 'S', scope: '', acceptanceCriteria: [], deliverables: [],
      projectSlug: 'alpha', repoPath: repo, baseBranch: 'base-desenvolvimento', buildCommand: 'true', testCommand: 'true',
      agentId: 'a', workspacePath: workspace.path, workspaceBranch: workspace.branch, workspaceBaseCommit: workspace.baseCommit,
    }

    await expect(new GitVerificationIntegrator(preparer).verifyAndIntegrate(context)).rejects.toThrow('0001_orphan.sql')
  })
})
// @vitest-environment node
