// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitWorktreePreparer } from '../src/execution/GitWorktreePreparer.js'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import type { OperationLogEntry, OperationLogger } from '../src/commands/index.js'
import { createQueueMessage } from '../src/queue/index.js'

const tempDirs: string[] = []

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function fixture(): Promise<{ repo: string; root: string; worktree: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'motor-cleanup-repo-'))
  const root = await mkdtemp(join(tmpdir(), 'motor-cleanup-root-'))
  tempDirs.push(repo, root)
  git(['init', '-b', 'base-desenvolvimento', repo], repo)
  git(['config', 'user.email', 'motor@test.local'], repo)
  git(['config', 'user.name', 'Motor Test'], repo)
  await writeFile(join(repo, 'tracked.txt'), 'base\n')
  git(['add', '-A'], repo)
  git(['commit', '-m', 'base'], repo)
  const worktree = join(root, 'task-cleanup', '1516', 'a1')
  git(['worktree', 'add', '-b', 'motor-v3-work/subtask-task-cleanup-1516-a1', worktree, 'base-desenvolvimento'], repo)
  return { repo, root, worktree }
}

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
})

describe('GitWorktreePreparer.cleanup — salvaguarda de artefatos', () => {
  it('copia arquivo untracked para caminho persistente antes de remover o worktree', async () => {
    const { repo, root, worktree } = await fixture()
    await writeFile(join(worktree, 'runbook.md'), '# runbook do deploy\n')

    const report = await new GitWorktreePreparer(root).cleanup('task-cleanup', repo)
    const recoveredPath = join(root, '.motor-artifacts', 'task-cleanup', '1516', 'a1', 'runbook.md')

    expect(existsSync(worktree)).toBe(false)
    expect(await readFile(recoveredPath, 'utf8')).toBe('# runbook do deploy\n')
    expect(report.artifactSalvage).toHaveLength(1)
    expect(report.artifactSalvage[0]?.files[0]?.artifactPath).toBe(recoveredPath)
    expect(existsSync(join(root, 'task-cleanup'))).toBe(false)
  })

  it('mantém o fluxo feliz: worktree limpo é removido sem criar artefatos', async () => {
    const { repo, root, worktree } = await fixture()

    const report = await new GitWorktreePreparer(root).cleanup('task-cleanup', repo)

    expect(report.artifactSalvage).toEqual([])
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(join(root, '.motor-artifacts'))).toBe(false)
    expect(git(['branch', '--list', 'motor-v3-work/subtask-task-cleanup-1516-a1'], repo).trim()).toBe('')
  })
})

describe('DeployConsumer — falha no resgate é best-effort', () => {
  it('preserva conclusão, registra erro e alerta sem propagar ao receiveResult', async () => {
    const entries: OperationLogEntry[] = []
    const logger: OperationLogger = { async append(entry) { entries.push(entry) } }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repository = {
      completeBatch: vi.fn(async () => ['task-cleanup']),
      repoPathForTask: vi.fn(async () => '/repo'),
      integrationBranchesAwaitingBaseSync: vi.fn(async () => []),
    } as never
    const cleanup = vi.fn(async () => ({
      removed: 1,
      branches: 1,
      artifactSalvage: [{
        worktreePath: '/worktrees/task-cleanup/1516/a1',
        artifactRoot: '/worktrees/.motor-artifacts/task-cleanup/1516/a1',
        files: [],
        errors: [{ path: 'runbook.md', error: 'EACCES: cópia recusada' }],
      }],
    }))
    const consumer = new DeployConsumer(repository, {} as never, {} as never, logger, undefined, undefined, undefined, undefined, { cleanup } as never)

    await expect(consumer.handle(createQueueMessage({
      type: 'DEPLOY_BATCH_RESULT_RECEIVED',
      taskId: 'system',
      executionId: 'deploy-result-salvage',
      payload: { batchId: 'batch-salvage', status: 'success' },
    }))).resolves.toBeUndefined()

    expect(repository.completeBatch).toHaveBeenCalledWith('batch-salvage', true, null, expect.anything())
    expect(entries.some(entry => entry.reasonCode === 'artifact_salvage_failed' && entry.outcome === 'failed')).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('worktree_artifact_salvage_failed'))
    warnSpy.mockRestore()
  })
})
