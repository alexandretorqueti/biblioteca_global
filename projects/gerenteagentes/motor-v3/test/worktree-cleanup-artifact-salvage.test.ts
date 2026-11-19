// @vitest-environment node
import { access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitWorktreePreparer } from '../src/execution/GitWorktreePreparer.js'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import type { OperationLogEntry, OperationLogger } from '../src/commands/index.js'
import type { TaskEventSink } from '../src/coordinator/TaskEventRecorder.js'
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

describe('DeployConsumer — GAP 1 resultado aponta para caminho real do artefato', () => {
  it('anota a subtarefa (evento) para o caminho persistente do artefato resgatado', async () => {
    const entries: OperationLogEntry[] = []
    const logger: OperationLogger = { async append(entry) { entries.push(entry) } }
    const events: Array<{ taskId: string; event: string; payload: Record<string, unknown> }> = []
    const taskEvents: TaskEventSink = {
      async record(taskId, event, _actor, payload) {
        events.push({ taskId, event, payload: payload ?? {} })
      },
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Worktree real: 1516/a1, sem branch de base, com arquivo que só existe fora do
    // worktree -> `isConfinedToWorktree`/status retorna vazio (considerado persistente,
    // a responsabilidade desta salvaguarda e o artefato fora do trabalho). O ponto
    // verificado e a ANOTACAO persistente, nao a classificacao de confinamento.
    const worktreePath = join('/worktrees', 'task-cleanup', '1516', 'a1')
    const repository = {
      completeBatch: vi.fn(async () => ['task-cleanup']),
      repoPathForTask: vi.fn(async () => '/repo'),
      integrationBranchesAwaitingBaseSync: vi.fn(async () => []),
    } as never
    const cleanup = vi.fn(async () => ({
      removed: 1,
      branches: 1,
      artifactSalvage: [{
        worktreePath,
        artifactRoot: '/worktrees/.motor-artifacts/task-cleanup/1516/a1',
        files: [{ sourcePath: join(worktreePath, 'docs', 'billing', 'SANDBOX-E2E-RUNBOOK.md'), artifactPath: '/worktrees/.motor-artifacts/task-cleanup/1516/a1/docs/billing/SANDBOX-E2E-RUNBOOK.md' }],
        errors: [],
      }],
    }))
    const consumer = new DeployConsumer(repository, {} as never, {} as never, logger, undefined, undefined, undefined, undefined, { cleanup } as never, undefined, undefined, undefined, undefined, taskEvents)

    await consumer.handle(createQueueMessage({
      type: 'DEPLOY_BATCH_RESULT_RECEIVED',
      taskId: 'system',
      executionId: 'deploy-result-salvage',
      payload: { batchId: 'batch-salvage', status: 'success' },
    }))

    // GAP 1: a subtarefa 1516 e anotada com o evento `subtask.artifacts_salvaged`
    // apontando para o caminho persistente (nao o caminho morto do worktree).
    expect(events.some((evt) => evt.event === 'subtask.artifacts_salvaged')).toBe(true)
    const salvaged = events.find((evt) => evt.event === 'subtask.artifacts_salvaged')!
    expect(salvaged.taskId).toBe('task-cleanup')
    expect(salvaged.payload.artifactRoot).toBe('/worktrees/.motor-artifacts/task-cleanup/1516/a1')
    const salvagedFile = salvaged.payload.salvaged as Array<{ artifactPath: string }>
    expect(salvagedFile.length).toBe(1)
    expect(salvagedFile[0]!.artifactPath).toContain('/.motor-artifacts/task-cleanup/1516/a1/')
    // Operation log do deploy tambem registra o resgate (preservado).
    expect(entries.some((e) => e.reasonCode === 'artifact_salvaged')).toBe(true)
  })
})

describe('DeployConsumer — GAP 1 ponta a ponta (artefato real recuperavel)', () => {
  it('apos conclusao+cleanup o arquivo sobrevive em .motor-artifacts e a anotacao aponta para o caminho real', async () => {
    // Monta um repositorio/worktree reais como no incidente isas-mt-06/1493:
    // a subtarefa grava docs/.../SANDBOX-E2E-RUNBOOK.md APENAS no worktree.
    const repo = await mkdtemp(join(tmpdir(), 'motor-gap1-repo-'))
    const root = await mkdtemp(join(tmpdir(), 'motor-gap1-root-'))
    tempDirs.push(repo, root)
    git(['init', '-b', 'base-desenvolvimento', repo], repo)
    git(['config', 'user.email', 'motor@test.local'], repo)
    git(['config', 'user.name', 'Motor Test'], repo)
    await writeFile(join(repo, 'tracked.txt'), 'base\n')
    git(['add', '-A'], repo)
    git(['commit', '-m', 'base'], repo)
    const worktree = join(root, 'task-cleanup', '1516', 'a1')
    git(['worktree', 'add', '-b', 'motor-v3-work/subtask-task-cleanup-1516-a1', worktree, 'base-desenvolvimento'], repo)
    const runbook = join(worktree, 'docs', 'billing', 'SANDBOX-E2E-RUNBOOK.md')
    await mkdir(dirname(runbook), { recursive: true })
    await writeFile(runbook, '# runbook E2E\n')

    const entries: OperationLogEntry[] = []
    const logger: OperationLogger = { async append(entry) { entries.push(entry) } }
    const events: Array<{ taskId: string; event: string; payload: Record<string, unknown> }> = []
    const taskEvents: TaskEventSink = {
      async record(taskId, event, _actor, payload) {
        events.push({ taskId, event, payload: payload ?? {} })
      },
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const repository = {
      completeBatch: vi.fn(async () => ['task-cleanup']),
      repoPathForTask: vi.fn(async () => repo),
      integrationBranchesAwaitingBaseSync: vi.fn(async () => []),
    } as never
    const preparer = new GitWorktreePreparer(root)
    const consumer = new DeployConsumer(repository, {} as never, {} as never, logger, undefined, undefined, undefined, undefined, preparer, undefined, undefined, undefined, undefined, taskEvents)

    await consumer.handle(createQueueMessage({
      type: 'DEPLOY_BATCH_RESULT_RECEIVED',
      taskId: 'system',
      executionId: 'deploy-result-gap1',
      payload: { batchId: 'batch-gap1', status: 'success' },
    }))

    // Cleanup removeu o worktree.
    expect(existsSync(worktree)).toBe(false)
    // Artefato recuperavel em .motor-artifacts (fonte da verdade persistente).
    const recovered = join(root, '.motor-artifacts', 'task-cleanup', '1516', 'a1', 'docs', 'billing', 'SANDBOX-E2E-RUNBOOK.md')
    expect(existsSync(recovered)).toBe(true)
    expect(await readFile(recovered, 'utf8')).toBe('# runbook E2E\n')
    // access() apontando para o caminho anotado passa (nao e caminho morto).
    await expect(access(recovered)).resolves.not.toThrow()
    // GAP 1: a anotacao da subtarefa 1516 aponta exatamente para `recovered`.
    const salvaged = events.find((evt) => evt.event === 'subtask.artifacts_salvaged')
    expect(salvaged, 'evento subtask.artifacts_salvaged').toBeTruthy()
    expect(salvaged!.taskId).toBe('task-cleanup')
    const salvagedFile = salvaged!.payload.salvaged as Array<{ artifactPath: string }>
    expect(salvagedFile.map((f) => f.artifactPath)).toContain(recovered)
    // Operation log do deploy tambem registra o resgate (preservado).
    expect(entries.some((e) => e.reasonCode === 'artifact_salvaged')).toBe(true)
  })
})
