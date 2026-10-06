import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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

  it('recupera diretório de subtarefa corrompido e reaproveita a branch residual válida', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-retry-'))
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
    const integration = await preparer.prepareIntegration({ taskId: 'task-retry', repoPath: repository, baseBranch: 'base-desenvolvimento' })
    const path = join(worktrees, 'task-retry', '42', 'a1')
    const branch = 'motor-v3-work/subtask-task-retry-42-a1'
    await mkdir(path, { recursive: true })
    await writeFile(join(path, '.git'), 'gitdir: /lost/.git/worktrees/a171\n')
    await execFileAsync('git', ['branch', branch, integration.baseCommit], { cwd: repository })

    const prepared = await preparer.prepare({ taskId: 'task-retry', subtaskId: 42, repoPath: repository, baseBranch: 'base-desenvolvimento' })

    expect(prepared.recoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'corrupt_subtask_worktree', action: 'removed_and_pruned' }),
      expect.objectContaining({ reasonCode: 'reused_residual_branch', action: 'reused_branch', branch }),
    ]))
    await expect(execFileAsync('git', ['status', '--porcelain'], { cwd: prepared.path })).resolves.toMatchObject({ stdout: '' })
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repository })
    expect(stdout).toContain(`worktree ${path}`)
    expect(stdout).toContain(`branch refs/heads/${branch}`)
  })

  it('reutiliza worktree íntegro sem recuperação', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-reuse-'))
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
    const first = await preparer.prepare({ taskId: 'task-reuse', subtaskId: 12, repoPath: repository, baseBranch: 'base-desenvolvimento' })
    const second = await preparer.prepare({ taskId: 'task-reuse', subtaskId: 12, repoPath: repository, baseBranch: 'base-desenvolvimento' })

    expect(second.baseCommit).toBe(first.baseCommit)
    expect(second.recoveries).toEqual([])
  })

  it('coloca diretório órfão da integração em quarentena antes de recriá-lo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-integration-orphan-'))
    temporaryPaths.push(root)
    const repository = join(root, 'repo')
    const worktrees = join(root, 'worktrees')
    await execFileAsync('git', ['init', '-b', 'base-desenvolvimento', repository])
    await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.name', 'Motor v3 test'], { cwd: repository })
    await writeFile(join(repository, 'README.md'), 'base\n')
    await execFileAsync('git', ['add', 'README.md'], { cwd: repository })
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repository })
    const orphan = join(worktrees, 'task-orphan', 'integration')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'audit.txt'), 'preserve me\n')

    const prepared = await new GitWorktreePreparer(worktrees).prepareIntegration({ taskId: 'task-orphan', repoPath: repository, baseBranch: 'base-desenvolvimento' })

    const recovery = prepared.recoveries.find(item => item.reasonCode === 'orphan_integration_directory')
    expect(recovery?.quarantinePath).toMatch(/integration\.orphan-\d+$/)
    await expect(access(join(recovery!.quarantinePath!, 'audit.txt'))).resolves.toBeUndefined()
    await expect(execFileAsync('git', ['status', '--porcelain'], { cwd: prepared.path })).resolves.toMatchObject({ stdout: '' })
    expect((await readdir(join(worktrees, 'task-orphan'))).some(name => name.startsWith('integration.orphan-'))).toBe(true)
  })

  it('cleanup remove somente os worktrees/branches da tarefa e o diretório da tarefa', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-cleanup-'))
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
    const integration = await preparer.prepareIntegration({ taskId: 'task-1', repoPath: repository, baseBranch: 'base-desenvolvimento' })
    const subtask = await preparer.prepare({ taskId: 'task-1', subtaskId: 10, repoPath: repository, baseBranch: 'base-desenvolvimento' })
    // Worktree de outra tarefa que NÃO pode ser tocado pela limpeza.
    await preparer.prepareIntegration({ taskId: 'task-2', repoPath: repository, baseBranch: 'base-desenvolvimento' })
    // Conteúdo não registrado dentro do diretório da tarefa (sujeito a rm -rf).
    await writeFile(join(worktrees, 'task-1', 'solto.txt'), 'x\n')

    const result = await preparer.cleanup('task-1', repository)

    expect(result).toEqual({ removed: 2, branches: 2 })
    await expect(access(integration.path)).rejects.toThrow()
    await expect(access(subtask.path)).rejects.toThrow()
    await expect(access(join(worktrees, 'task-1'))).rejects.toThrow()
    // Branches da tarefa desaparecem; a da outra tarefa permanece.
    await expect(execFileAsync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/motor-v3-work/integration-task-1'], { cwd: repository })).rejects.toThrow()
    await expect(execFileAsync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/motor-v3-work/subtask-task-1-10-a1'], { cwd: repository })).rejects.toThrow()
    await expect(execFileAsync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/motor-v3-work/integration-task-2'], { cwd: repository })).resolves.toBeDefined()
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repository })
    expect(stdout).not.toContain(join(worktrees, 'task-1'))
    expect(stdout).toContain(join(worktrees, 'task-2', 'integration'))
  })

  it('cleanup é idempotente: segunda limpeza não lança erro e remove zero itens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motor-v3-cleanup-idem-'))
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
    await preparer.prepareIntegration({ taskId: 'task-9', repoPath: repository, baseBranch: 'base-desenvolvimento' })

    await expect(preparer.cleanup('task-9', repository)).resolves.toEqual({ removed: 1, branches: 1 })
    // Segunda chamada: nada registrado, diretório já removido → zero remoções, sem erro.
    await expect(preparer.cleanup('task-9', repository)).resolves.toEqual({ removed: 0, branches: 0 })
  })
})
// @vitest-environment node
