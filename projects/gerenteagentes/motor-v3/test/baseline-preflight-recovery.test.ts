// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { persistBaselineCorrection } from '../src/testing/BaselinePreflightRecovery.js'

const execFileAsync = promisify(execFile)
const temporaryRepositories: string[] = []

async function repository(): Promise<{ path: string; baseCommit: string }> {
  const path = await mkdtemp(join(tmpdir(), 'baseline-preflight-recovery-'))
  temporaryRepositories.push(path)
  await execFileAsync('git', ['init'], { cwd: path })
  await execFileAsync('git', ['config', 'user.name', 'Motor Test'], { cwd: path })
  await execFileAsync('git', ['config', 'user.email', 'motor@example.test'], { cwd: path })
  await writeFile(join(path, 'baseline.txt'), 'red\n')
  await execFileAsync('git', ['add', '.'], { cwd: path })
  await execFileAsync('git', ['commit', '-m', 'baseline'], { cwd: path })
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path })
  return { path, baseCommit: stdout.trim() }
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('persistBaselineCorrection', () => {
  it('aceita a correção que o Monitor já commitou', async () => {
    const repo = await repository()
    await writeFile(join(repo.path, 'baseline.txt'), 'green\n')
    await execFileAsync('git', ['add', '.'], { cwd: repo.path })
    await execFileAsync('git', ['commit', '-m', 'monitor correction'], { cwd: repo.path })
    const { stdout: monitorCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo.path })

    await expect(persistBaselineCorrection(repo.path, repo.baseCommit, 'motor correction'))
      .resolves.toBe(monitorCommit.trim())
  })

  it('commita uma correção ainda não persistida pelo Monitor', async () => {
    const repo = await repository()
    await writeFile(join(repo.path, 'baseline.txt'), 'green\n')

    const commit = await persistBaselineCorrection(repo.path, repo.baseCommit, 'motor correction')

    expect(commit).not.toBe(repo.baseCommit)
    const { stdout: subject } = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: repo.path })
    expect(subject.trim()).toBe('motor correction')
  })

  it('rejeita conclusão sem mudança nem commit', async () => {
    const repo = await repository()

    await expect(persistBaselineCorrection(repo.path, repo.baseCommit, 'motor correction'))
      .resolves.toBeNull()
  })
})
