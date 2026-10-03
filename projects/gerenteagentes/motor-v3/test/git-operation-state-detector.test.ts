import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitOperationBlockedError, GitOperationStateDetector } from '../src/execution/GitOperationStateDetector.js'

const execFileAsync = promisify(execFile)

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'motor-v3-git-state-'))
  await execFileAsync('git', ['init', '-b', 'main', root])
  await execFileAsync('git', ['config', 'user.email', 'motor@example.test'], { cwd: root })
  await execFileAsync('git', ['config', 'user.name', 'Motor Test'], { cwd: root })
  await writeFile(join(root, 'file.txt'), 'base\n')
  await execFileAsync('git', ['add', 'file.txt'], { cwd: root })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root })
  return root
}

describe('GitOperationStateDetector', () => {
  it.each([
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['MERGE_HEAD', 'merge'],
    ['REBASE_HEAD', 'rebase'],
  ] as const)('detecta %s pelo marcador do .git', async (marker, operation) => {
    const repo = await repository()
    await writeFile(join(repo, '.git', marker), 'pending\n')
    const state = await new GitOperationStateDetector().detect(repo)
    expect(state).toMatchObject({ marker, operation, markerPath: join(repo, '.git', marker) })
  })

  it('mantém abort e continue idempotentes sem operação pendente', async () => {
    const detector = new GitOperationStateDetector()
    const repo = await repository()
    await expect(detector.abort(repo)).resolves.toBe(false)
    await expect(detector.abort(repo)).resolves.toBe(false)
    await expect(detector.continue(repo)).resolves.toBe(false)
    await expect(detector.continue(repo)).resolves.toBe(false)
  })

  it('expõe arquivos conflitantes no bloqueio acionável', async () => {
    const repo = await repository()
    await writeFile(join(repo, '.git', 'CHERRY_PICK_HEAD'), 'pending\n')
    await writeFile(join(repo, 'conflict.txt'), 'conflict\n')
    const detector = new GitOperationStateDetector()
    await expect(detector.recover(repo)).rejects.toBeInstanceOf(GitOperationBlockedError)
  })
})
