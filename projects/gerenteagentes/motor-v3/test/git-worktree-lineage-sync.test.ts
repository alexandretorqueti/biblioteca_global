import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GitWorktreePreparer,
  IntegrationBaseSyncConflictError,
} from '../src/execution/GitWorktreePreparer.js'

const execFileAsync = promisify(execFile)
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface LineageEnvironment {
  root: string
  origin: string
  repo: string
  worktrees: string
  preparer: GitWorktreePreparer
}

/**
 * Ambiente com remote real: a base só avança via push no `origin`, exatamente
 * como o promote do motor faz em produção (fetch + reset a partir de um worktree
 * destacado, sem movimentar a ref local da base).
 */
async function createEnvironment(): Promise<LineageEnvironment> {
  const root = await mkdtemp(join(tmpdir(), 'motor-v3-lineage-'))
  temporaryPaths.push(root)
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  const worktrees = join(root, 'worktrees')
  await execFileAsync('git', ['init', '--bare', '-b', 'base-desenvolvimento', origin])
  await execFileAsync('git', ['clone', origin, repo])
  for (const cwd of [repo]) {
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd })
    await execFileAsync('git', ['config', 'user.name', 'Motor v3 test'], { cwd })
  }
  await writeFile(join(repo, 'README.md'), 'base\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: repo })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo })
  await execFileAsync('git', ['push', '-u', 'origin', 'base-desenvolvimento'], { cwd: repo })
  return { root, origin, repo, worktrees, preparer: new GitWorktreePreparer(worktrees) }
}

/** Publica um commit novo na base, como o promote de outra tarefa faria. */
async function advanceBase(env: LineageEnvironment, file: string, content: string, message: string): Promise<string> {
  await mkdir(join(env.repo, dirname(file)), { recursive: true })
  await writeFile(join(env.repo, file), content)
  await execFileAsync('git', ['add', file], { cwd: env.repo })
  await execFileAsync('git', ['commit', '-m', message], { cwd: env.repo })
  await execFileAsync('git', ['push', 'origin', 'base-desenvolvimento'], { cwd: env.repo })
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: env.repo })
  return stdout.trim()
}

async function prepareTask(env: LineageEnvironment, taskId: string, subtaskId: number) {
  const prepared = await env.preparer.prepare({
    taskId, subtaskId, repoPath: env.repo, baseBranch: 'base-desenvolvimento',
  })
  return prepared
}

async function head(path: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path })
  return stdout.trim()
}

async function status(path: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: path })
  return stdout
}

describe('GitWorktreePreparer — sync da linhagem com a base promovida', () => {
  it('traz a base promovida para a integração e avança o worktree da subtarefa', async () => {
    const env = await createEnvironment()
    const prepared = await prepareTask(env, 'task-lineage', 77)
    const baseCommit = await advanceBase(env, 'packages/shared/tenant.ts', 'export const tenant = true\n', 'feat: tenants promovido')

    const integration = await env.preparer.prepareIntegration({
      taskId: 'task-lineage', repoPath: env.repo, baseBranch: 'base-desenvolvimento', subtaskId: 77,
    })

    expect(integration.lineage).toMatchObject({ status: 'merged', baseRef: 'origin/base-desenvolvimento' })
    expect(integration.lineage?.subtaskCommit).toBe(integration.baseCommit)
    expect(integration.baseCommit).not.toBe(prepared.baseCommit)
    // O contrato promovido fica visível nos DOIS worktrees (baseline e dev).
    await expect(execFileAsync('git', ['merge-base', '--is-ancestor', baseCommit, integration.integrationBranch], { cwd: env.repo })).resolves.toBeDefined()
    expect(await head(prepared.path)).toBe(integration.baseCommit)
    await expect(execFileAsync('git', ['cat-file', '-e', `${integration.baseCommit}:packages/shared/tenant.ts`], { cwd: env.repo })).resolves.toBeDefined()
    expect(await status(prepared.path)).toBe('')
  })

  it('é idempotente quando a base já está na linhagem', async () => {
    const env = await createEnvironment()
    const prepared = await prepareTask(env, 'task-uptodate', 12)
    await advanceBase(env, 'docs/novo.md', 'novo\n', 'docs: novo')
    const first = await env.preparer.prepareIntegration({
      taskId: 'task-uptodate', repoPath: env.repo, baseBranch: 'base-desenvolvimento', subtaskId: 12,
    })
    expect(first.lineage?.status).toBe('merged')

    const second = await env.preparer.prepareIntegration({
      taskId: 'task-uptodate', repoPath: env.repo, baseBranch: 'base-desenvolvimento', subtaskId: 12,
    })

    expect(second.lineage).toMatchObject({ status: 'up_to_date' })
    expect(second.baseCommit).toBe(first.baseCommit)
    expect(await head(prepared.path)).toBe(first.baseCommit)
  })

  it('não toca na linhagem quando a subtarefa já tem commits próprios', async () => {
    const env = await createEnvironment()
    const prepared = await prepareTask(env, 'task-commits', 21)
    await advanceBase(env, 'apps/api/novo.ts', 'export const novo = 1\n', 'feat: promovido')
    await writeFile(join(prepared.path, 'apps-api-trabalho.txt'), 'trabalho do dev\n')
    await execFileAsync('git', ['add', 'apps-api-trabalho.txt'], { cwd: prepared.path })
    await execFileAsync('git', ['commit', '-m', 'trabalho da subtarefa'], { cwd: prepared.path })
    const devCommit = await head(prepared.path)

    const integration = await env.preparer.prepareIntegration({
      taskId: 'task-commits', repoPath: env.repo, baseBranch: 'base-desenvolvimento', subtaskId: 21,
    })

    expect(integration.lineage).toMatchObject({ status: 'skipped', reason: 'subtask_has_commits' })
    expect(integration.baseCommit).toBe(prepared.baseCommit)
    expect(await head(prepared.path)).toBe(devCommit)
  })

  it('não toca na linhagem quando o worktree da subtarefa está sujo', async () => {
    const env = await createEnvironment()
    const prepared = await prepareTask(env, 'task-dirty', 33)
    await advanceBase(env, 'apps/api/outro.ts', 'export const outro = 1\n', 'feat: promovido')
    await writeFile(join(prepared.path, 'rascunho.txt'), 'rascunho não commitado\n')

    const integration = await env.preparer.prepareIntegration({
      taskId: 'task-dirty', repoPath: env.repo, baseBranch: 'base-desenvolvimento', subtaskId: 33,
    })

    expect(integration.lineage).toMatchObject({ status: 'skipped', reason: 'subtask_worktree_dirty' })
    expect(integration.baseCommit).toBe(prepared.baseCommit)
    expect(await status(prepared.path)).toContain('rascunho.txt')
  })

  it('bloqueia com motivo explícito e integração limpa quando o merge da base conflita', async () => {
    const env = await createEnvironment()
    const prepared = await prepareTask(env, 'task-conflict', 44)
    // Mesmo arquivo, mesmo lado: a integração muda uma linha e a base muda outra.
    await writeFile(join(prepared.integrationPath, 'README.md'), 'integracao\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: prepared.integrationPath })
    await execFileAsync('git', ['commit', '-m', 'mudanca da integracao'], { cwd: prepared.integrationPath })
    await writeFile(join(env.repo, 'README.md'), 'base promovida\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: env.repo })
    await execFileAsync('git', ['commit', '-m', 'mudanca da base'], { cwd: env.repo })
    await execFileAsync('git', ['push', 'origin', 'base-desenvolvimento'], { cwd: env.repo })
    const integrationBefore = await head(prepared.integrationPath)

    await expect(env.preparer.prepareIntegration({
      taskId: 'task-conflict', repoPath: env.repo, baseBranch: 'base-desenvolvimento', subtaskId: 44,
    })).rejects.toBeInstanceOf(IntegrationBaseSyncConflictError)

    // Merge abortado: a integração continua utilizável e sem resíduos, e o
    // worktree da subtarefa não foi movimentado.
    expect(await status(prepared.integrationPath)).toBe('')
    expect(await head(prepared.integrationPath)).toBe(integrationBefore)
    expect(await head(prepared.path)).toBe(prepared.baseCommit)
  })

  it('degrada para skipped quando não há remote para consultar', async () => {
    const env = await createEnvironment()
    const prepared = await prepareTask(env, 'task-noremote', 55)
    await execFileAsync('git', ['remote', 'remove', 'origin'], { cwd: env.repo })

    const integration = await env.preparer.prepareIntegration({
      taskId: 'task-noremote', repoPath: env.repo, baseBranch: 'base-desenvolvimento', subtaskId: 55,
    })

    expect(integration.lineage?.status).toBe('skipped')
    expect(integration.lineage?.reason).toBe('fetch_unavailable')
    expect(integration.baseCommit).toBe(prepared.baseCommit)
  })

  it('não sincroniza quando prepareIntegration é chamado sem subtarefa (fluxo de deploy/integração)', async () => {
    const env = await createEnvironment()
    const prepared = await prepareTask(env, 'task-nosubtask', 66)
    await advanceBase(env, 'apps/api/sem-subtask.ts', 'export const x = 1\n', 'feat: promovido')

    const integration = await env.preparer.prepareIntegration({
      taskId: 'task-nosubtask', repoPath: env.repo, baseBranch: 'base-desenvolvimento',
    })

    expect(integration.lineage).toBeUndefined()
    expect(integration.baseCommit).toBe(prepared.baseCommit)
  })
})
