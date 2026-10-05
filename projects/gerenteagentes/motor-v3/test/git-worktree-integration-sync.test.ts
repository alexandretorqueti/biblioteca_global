import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[][] = []
let branchExists = true
let baseAlreadyMerged = false
let mergeFails = false

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_command: string, args: string[], options: { cwd?: string }, callback: Function) => {
    calls.push(args)
    if (args[0] === 'show-ref') return callback(branchExists ? null : new Error('missing'), { stdout: '', stderr: '' })
    if (args[0] === 'worktree') return callback(null, { stdout: `worktree ${options.cwd}/ignored\n`, stderr: '' })
    if (args[0] === 'merge-base') return callback(baseAlreadyMerged ? null : new Error('not ancestor'), { stdout: '', stderr: '' })
    if (args[0] === 'merge' && args[1] === '--no-ff' && mergeFails) return callback(new Error('conflict'), { stdout: '', stderr: '' })
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { GitWorktreePreparer } from '../src/execution/GitWorktreePreparer.js'

describe('GitWorktreePreparer.syncIntegrationBranch', () => {
  let root: string
  let repo: string
  let integration: string

  beforeEach(async () => {
    calls.length = 0
    branchExists = true
    baseAlreadyMerged = false
    mergeFails = false
    root = await mkdtemp(join(tmpdir(), 'motor-sync-'))
    repo = await mkdtemp(join(tmpdir(), 'motor-repo-'))
    integration = join(root, 'task-1', 'integration')
    await mkdir(integration, { recursive: true })
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true }) })

  it('não toca no checkout base quando a branch ou o worktree não existem', async () => {
    branchExists = false
    const preparer = new GitWorktreePreparer(root)

    await expect(preparer.syncIntegrationBranch({ taskId: 'task-1', repoPath: repo, baseBranch: 'base-desenvolvimento' })).resolves.toBe('skipped')
    expect(calls.some(args => args[0] === 'merge')).toBe(false)
  })

  it('faz merge no worktree de integração, é idempotente e aborta conflitos', async () => {
    const preparer = new GitWorktreePreparer(root)
    // O mock lista exatamente o worktree de integração registrado.
    ;(await import('node:child_process')).execFile.mockImplementation((_command: string, args: string[], options: { cwd?: string }, callback: Function) => {
      calls.push(args)
      if (args[0] === 'show-ref') return callback(branchExists ? null : new Error('missing'), { stdout: '', stderr: '' })
      if (args[0] === 'worktree') return callback(null, { stdout: `worktree ${integration}\n`, stderr: '' })
      if (args[0] === 'merge-base') return callback(baseAlreadyMerged ? null : new Error('not ancestor'), { stdout: '', stderr: '' })
      if (args[0] === 'merge' && args[1] === '--no-ff' && mergeFails) return callback(new Error('conflict'), { stdout: '', stderr: '' })
      return callback(null, { stdout: '', stderr: '' })
    })

    await expect(preparer.syncIntegrationBranch({ taskId: 'task-1', repoPath: repo, baseBranch: 'base-desenvolvimento' })).resolves.toBe('merged')
    expect(calls.some(args => args.join(' ') === 'fetch origin base-desenvolvimento')).toBe(true)
    expect(calls.some(args => args.join(' ') === 'merge --no-ff --no-commit origin/base-desenvolvimento')).toBe(true)

    calls.length = 0
    baseAlreadyMerged = true
    await expect(preparer.syncIntegrationBranch({ taskId: 'task-1', repoPath: repo, baseBranch: 'base-desenvolvimento' })).resolves.toBe('up_to_date')
    expect(calls.some(args => args[0] === 'merge')).toBe(false)

    calls.length = 0
    baseAlreadyMerged = false
    mergeFails = true
    await expect(preparer.syncIntegrationBranch({ taskId: 'task-1', repoPath: repo, baseBranch: 'base-desenvolvimento' })).rejects.toThrow('conflict')
    expect(calls.some(args => args.join(' ') === 'merge --abort')).toBe(true)
  })
})
