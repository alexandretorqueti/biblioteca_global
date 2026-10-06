import { execFile } from 'node:child_process'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Erro lançado quando a branch de integração não existe e não pode ser recriada.
 * O motor deve tratar isso como "resetar subtarefas para pendente e tarefa para pronta".
 */
export class IntegrationBranchMissingError extends Error {
  constructor(public readonly taskId: string, public readonly branch: string) {
    super(`Branch de integração inexistente: ${branch} para tarefa ${taskId}`)
    this.name = 'IntegrationBranchMissingError'
  }
}

export interface PreparedWorktree {
  path: string
  branch: string
  baseCommit: string
  integrationPath: string
  integrationBranch: string
  recoveries?: WorktreeRecovery[]
}

export interface WorktreeRecovery {
  reasonCode: 'corrupt_subtask_worktree' | 'orphan_integration_directory' | 'orphan_worktree_registration' | 'reused_residual_branch' | 'discarded_residual_branch'
  path: string
  action: 'removed_and_pruned' | 'quarantined' | 'reused_branch' | 'deleted_branch'
  branch?: string
  quarantinePath?: string
}

export interface IntegrationBranchSyncInput {
  taskId: string
  repoPath: string
  baseBranch: string
}

export function mapHostRepoPathToContainer(repoPath: string): string | null {
  const original = resolve(repoPath)
  const hostPrefix = '/home/alexandre/codigofonte/'
  const containerPrefix = '/data/workspace/projects/codigofonte/'
  if (!original.startsWith(hostPrefix)) return null
  return resolve(containerPrefix, original.slice(hostPrefix.length))
}

/** Prepara um worktree isolado sem alterar o checkout da branch base. */
export class GitWorktreePreparer {
  constructor(private readonly root: string) {}

  async prepare(input: { taskId: string; subtaskId: number; repoPath: string; baseBranch: string }): Promise<PreparedWorktree> {
    if (!input.repoPath || !input.baseBranch) throw new Error('Projeto sem repo_path ou branch_trabalho configurados')
    const repoPath = await this.resolveRepoPath(input.repoPath)
    await this.assertGitAvailable()
    const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, '-')
    // `motor-v3` já é uma branch histórica; Git não permite refs filhas de
    // uma branch existente (`motor-v3/...`). O runtime usa namespace próprio.
    const taskBranch = `motor-v3-work/integration-${safeTaskId}`
    const integrationPath = resolve(this.root, safeTaskId, 'integration')
    const integration = await this.prepareNamedWorktree(repoPath, input.baseBranch, taskBranch, integrationPath)
    const branch = `motor-v3-work/subtask-${safeTaskId}-${input.subtaskId}-a1`
    const path = resolve(this.root, safeTaskId, String(input.subtaskId), 'a1')
    await mkdir(dirname(path), { recursive: true })

    const recoveries = [...integration.recoveries]
    const existingCommit = await this.existingWorktreeCommit(repoPath, path, branch)
    if (existingCommit) return { path, branch, baseCommit: existingCommit, integrationPath, integrationBranch: taskBranch, recoveries }
    if (await this.exists(path) || await this.isRegisteredWorktree(repoPath, path)) {
      await this.removeBrokenSubtaskWorktree(repoPath, path)
      recoveries.push({ reasonCode: 'corrupt_subtask_worktree', path, action: 'removed_and_pruned', branch })
    }

    const { stdout } = await execFileAsync('git', ['rev-parse', taskBranch], { cwd: repoPath })
    const baseCommit = stdout.trim()
    const branchExists = await this.branchExists(repoPath, branch)
    if (branchExists) {
      if (await this.branchHasWorktree(repoPath, branch) || !await this.branchResolvesToCommit(repoPath, branch)) {
        await this.removeBranchWorktrees(repoPath, branch)
        await this.deleteBranch(repoPath, branch)
        recoveries.push({ reasonCode: 'discarded_residual_branch', path, action: 'deleted_branch', branch })
        await execFileAsync('git', ['worktree', 'add', '-b', branch, path, baseCommit], { cwd: repoPath })
      } else {
        await execFileAsync('git', ['worktree', 'add', path, branch], { cwd: repoPath })
        recoveries.push({ reasonCode: 'reused_residual_branch', path, action: 'reused_branch', branch })
      }
    } else {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, path, baseCommit], { cwd: repoPath })
    }
    return { path, branch, baseCommit, integrationPath, integrationBranch: taskBranch, recoveries }
  }

  async prepareIntegration(input: { taskId: string; repoPath: string; baseBranch: string }): Promise<PreparedWorktree> {
    const repoPath = await this.resolveRepoPath(input.repoPath)
    await this.assertGitAvailable()
    const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, '-')
    const branch = `motor-v3-work/integration-${safeTaskId}`
    const path = resolve(this.root, safeTaskId, 'integration')
    const prepared = await this.prepareNamedWorktree(repoPath, input.baseBranch, branch, path, input.taskId)
    return { path, branch, baseCommit: prepared.commit, integrationPath: path, integrationBranch: branch, recoveries: prepared.recoveries }
  }

  private async prepareNamedWorktree(repoPath: string, baseRef: string, branch: string, path: string, taskId?: string): Promise<{ commit: string; recoveries: WorktreeRecovery[] }> {
    await mkdir(dirname(path), { recursive: true })
    const recoveries: WorktreeRecovery[] = []
    const existingCommit = await this.existingWorktreeCommit(repoPath, path, branch)
    if (existingCommit) return { commit: existingCommit, recoveries }
    if (await this.exists(path)) {
      const quarantinePath = await this.quarantine(path)
      recoveries.push({ reasonCode: 'orphan_integration_directory', path, action: 'quarantined', branch, quarantinePath })
    }
    if (await this.isRegisteredWorktree(repoPath, path)) {
      await this.removeOrphanedWorktree(repoPath, path)
      recoveries.push({ reasonCode: 'orphan_worktree_registration', path, action: 'removed_and_pruned', branch })
    }
    const branchExists = await this.branchExists(repoPath, branch)
    // Se a branch não existe e não é uma branch de integração nova (baseRef não é uma branch válida),
    // significa que o ambiente foi perdido e não pode ser recriado
    if (!branchExists && taskId && branch.includes('integration')) {
      // Verificar se a baseRef também não existe (ambiente completamente perdido)
      const baseExists = await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${baseRef}`], { cwd: repoPath })
        .then(() => true, () => false)
      if (!baseExists) {
        throw new IntegrationBranchMissingError(taskId, branch)
      }
    }
    try {
      if (branchExists) {
        await execFileAsync('git', ['worktree', 'add', path, branch], { cwd: repoPath })
      } else {
        await execFileAsync('git', ['worktree', 'add', '-b', branch, path, baseRef], { cwd: repoPath })
      }
    } catch (error: any) {
      const message = String(error?.stderr ?? error?.message ?? '')
      // Worktree registrado mas pasta física ausente (foi deletada manualmente)
      if (/missing but already registered worktree|already registered worktree/i.test(message)) {
        console.warn(`[GitWorktreePreparer] Worktree órfão detectado: ${path} — removendo registro e recriando`)
        await this.removeOrphanedWorktree(repoPath, path)
        // Tentar novamente após limpar o registro órfão
        if (branchExists) {
          await execFileAsync('git', ['worktree', 'add', path, branch], { cwd: repoPath })
        } else {
          await execFileAsync('git', ['worktree', 'add', '-b', branch, path, baseRef], { cwd: repoPath })
        }
      } else {
        throw error
      }
    }
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: path })
    return { commit: stdout.trim(), recoveries }
  }

  /**
   * Remove um worktree órfão (registrado mas com pasta física ausente).
   * Usa `git worktree remove --force` que limpa tanto o registro quanto o caminho (se existir).
   */
  private async removeOrphanedWorktree(repoPath: string, path: string): Promise<void> {
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', path], { cwd: repoPath })
    } catch {
      // Se o worktree remove falhar (caminho já não existe), tentar prune
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoPath })
    }
  }

  private async removeBrokenSubtaskWorktree(repoPath: string, path: string): Promise<void> {
    await this.removeOrphanedWorktree(repoPath, path)
    await rm(path, { recursive: true, force: true })
    await execFileAsync('git', ['worktree', 'prune'], { cwd: repoPath })
  }

  private async quarantine(path: string): Promise<string> {
    const candidate = `${path}.orphan-${Date.now()}`
    let quarantinePath = candidate
    let suffix = 0
    while (await this.exists(quarantinePath)) quarantinePath = `${candidate}-${++suffix}`
    await rename(path, quarantinePath)
    return quarantinePath
  }

  /**
   * Limpeza idempotente pós-deploy: remove APENAS os worktrees registrados cujo
   * caminho está sob `{root}/{safeTaskId}/`, as branches motor-v3-work da tarefa e,
   * por fim, o diretório da tarefa (mesmo com conteúdo não registrado pelo Git).
   * Idempotente: worktrees/branches já removidos e diretório inexistente não lançam erro.
   */
  async cleanup(taskId: string, repoPath: string): Promise<{ removed: number; branches: number }> {
    await this.assertGitAvailable()
    const repo = await this.resolveRepoPath(repoPath)
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]/g, '-')
    const taskRoot = resolve(this.root, safeTaskId)
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repo })
    const underTask = stdout.split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => resolve(line.slice('worktree '.length).trim()))
      .filter(path => path === taskRoot || path.startsWith(`${taskRoot}/`))
    let removed = 0
    for (const path of underTask) {
      await execFileAsync('git', ['worktree', 'remove', '--force', path], { cwd: repo })
      removed++
    }
    // Git não permite refs filhas de uma branch existente; o namespace real é motor-v3-work.
    let branches = await this.deleteBranch(repo, `motor-v3-work/integration-${safeTaskId}`)
    const { stdout: subtaskBranches } = await execFileAsync('git', ['branch', '--list', '--format=%(refname:short)', `motor-v3-work/subtask-${safeTaskId}-*`], { cwd: repo })
    for (const name of subtaskBranches.split('\n').map(line => line.trim()).filter(Boolean)) {
      branches += await this.deleteBranch(repo, name)
    }
    await rm(taskRoot, { recursive: true, force: true })
    console.log(`[Motor v3] Worktree cleanup taskId=${taskId} removed=${removed} branches=${branches}`)
    return { removed, branches }
  }

  /**
   * Atualiza uma integração interrompida a partir da base já promovida.
   * Não recria artefatos: sem worktree registrado ou sem branch, a tarefa é
   * ignorada. O merge acontece no worktree exclusivo da integração, jamais no
   * checkout compartilhado da base, e é abortado se qualquer etapa falhar.
   */
  async syncIntegrationBranch(input: IntegrationBranchSyncInput): Promise<'merged' | 'up_to_date' | 'skipped'> {
    await this.assertGitAvailable()
    const repo = await this.resolveRepoPath(input.repoPath)
    const safeTaskId = input.taskId.replace(/[^a-zA-Z0-9._-]/g, '-')
    const branch = `motor-v3-work/integration-${safeTaskId}`
    const path = resolve(this.root, safeTaskId, 'integration')
    const branchExists = await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo })
      .then(() => true, () => false)
    if (!branchExists || !await this.isRegisteredWorktree(repo, path) || !await this.exists(path)) return 'skipped'

    // A promoção faz push a partir de um worktree destacado e não movimenta a
    // ref local da base. Atualizar apenas a tracking ref preserva o checkout
    // compartilhado, mas garante que o merge usa a base realmente implantada.
    await execFileAsync('git', ['fetch', 'origin', input.baseBranch], { cwd: repo })
    const baseRef = `origin/${input.baseBranch}`
    const { stdout: headRef } = await execFileAsync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: path }).catch(() => ({ stdout: '' }))
    if (headRef.trim() !== `refs/heads/${branch}`) await execFileAsync('git', ['checkout', branch], { cwd: path })

    const baseAlreadyMerged = await execFileAsync('git', ['merge-base', '--is-ancestor', baseRef, branch], { cwd: repo })
      .then(() => true, () => false)
    if (baseAlreadyMerged) return 'up_to_date'

    try {
      await execFileAsync('git', ['merge', '--no-ff', '--no-commit', baseRef], { cwd: path })
      await execFileAsync('git', ['diff', '--check'], { cwd: path })
      await execFileAsync('git', ['commit', '--no-edit'], { cwd: path })
      return 'merged'
    } catch (error) {
      await execFileAsync('git', ['merge', '--abort'], { cwd: path }).catch(() => undefined)
      throw error
    }
  }

  /** Remove a branch se existir; retorna 1 quando removeu, 0 quando já não existia. */
  private async deleteBranch(repoPath: string, branch: string): Promise<number> {
    const exists = await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })
      .then(() => true, () => false)
    if (!exists) return 0
    await execFileAsync('git', ['branch', '-D', branch], { cwd: repoPath })
    return 1
  }

  private async branchExists(repoPath: string, branch: string): Promise<boolean> {
    return execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })
      .then(() => true, () => false)
  }

  private async branchResolvesToCommit(repoPath: string, branch: string): Promise<boolean> {
    return execFileAsync('git', ['rev-parse', '--verify', `${branch}^{commit}`], { cwd: repoPath })
      .then(() => true, () => false)
  }

  private async branchHasWorktree(repoPath: string, branch: string): Promise<boolean> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })
    return stdout.split('\n\n').some(entry => entry.split('\n').includes(`branch refs/heads/${branch}`))
  }

  /** Libera uma branch de subtarefa que ainda ficou presa a um registro residual. */
  private async removeBranchWorktrees(repoPath: string, branch: string): Promise<void> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })
    const paths = stdout.split('\n\n').flatMap(entry => {
      const lines = entry.split('\n')
      const worktree = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
      return worktree && lines.includes(`branch refs/heads/${branch}`) ? [worktree] : []
    })
    for (const path of paths) await this.removeBrokenSubtaskWorktree(repoPath, path)
  }

  private async exists(path: string): Promise<boolean> {
    try { await stat(path); return true } catch { return false }
  }

  private async isRegisteredWorktree(repoPath: string, path: string): Promise<boolean> {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })
    return stdout.split('\n').some(line => line === `worktree ${path}`)
  }

  /**
   * Verifica se um worktree já existe e retorna o commit atual.
   *
   * Se o worktree estiver detached (HEAD não aponta para nenhuma branch),
   * faz checkout da branch esperada para garantir consistência. Isso evita
   * que o deploy capture commits incorretos quando o worktree ficou em
   * estado detached por crash/interrupção anterior.
   */
  private async existingWorktreeCommit(repoPath: string, path: string, expectedBranch?: string): Promise<string | null> {
    if (!await this.exists(path)) return null
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath })
    const registered = stdout.split('\n').some(line => line === `worktree ${path}`)
    if (!registered) return null
    const [gitDir, commonDir] = await Promise.all([
      execFileAsync('git', ['-C', path, 'rev-parse', '--git-dir']).then(result => resolve(path, result.stdout.trim()), () => null),
      execFileAsync('git', ['-C', repoPath, 'rev-parse', '--git-common-dir']).then(result => resolve(repoPath, result.stdout.trim()), () => null),
    ])
    if (!gitDir || !commonDir || !gitDir.startsWith(`${commonDir}/worktrees/`) || !await this.exists(gitDir)) return null
    // Um worktree reutilizável precisa estar explicitamente na branch esperada.
    // Não fazemos checkout corretivo aqui: um retry não pode movimentar um
    // worktree cujo estado já divergiu do contrato da subtarefa.
    if (expectedBranch) {
      const { stdout: headRef } = await execFileAsync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: path })
        .catch(() => ({ stdout: '' }))
      const currentBranch = headRef.trim()
      const expectedRef = `refs/heads/${expectedBranch}`
      if (currentBranch !== expectedRef) return null
    }
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: path })
      .catch(() => ({ stdout: '' }))
    return commit.trim() || null
  }

  /** Converte o caminho persistido pelo host para o bind visível na API. */
  private async resolveRepoPath(repoPath: string): Promise<string> {
    const original = resolve(repoPath)
    if (await this.exists(original)) return original
    const mapped = mapHostRepoPathToContainer(original)
    if (mapped && await this.exists(mapped)) return mapped
    throw new Error(`Repositório inacessível no container do Motor: ${original}`)
  }

  private async assertGitAvailable(): Promise<void> {
    try {
      await access('/usr/bin/git')
    } catch {
      try {
        await execFileAsync('git', ['--version'])
      } catch {
        throw new Error('Ambiente do Motor sem executável git; reconstrua a imagem da API com git instalado')
      }
    }
  }
}
