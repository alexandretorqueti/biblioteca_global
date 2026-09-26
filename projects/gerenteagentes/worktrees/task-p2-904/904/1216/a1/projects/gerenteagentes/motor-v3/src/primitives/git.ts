/**
 * Primitivas de git (worktree, commit, merge, etc)
 */

import type { PrimitiveDefinition, PrimitiveContext, PrimitiveResult } from './types.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * create_worktree - Cria worktree isolado
 */
export const createWorktree: PrimitiveDefinition = {
  code: 'create_worktree',
  name: 'Criar worktree isolado',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { repoPath, worktreePath, branchName } = context

      context.logger?.info('Criando worktree', { repoPath, worktreePath, branchName })

      // Cria branch se não existir
      try {
        await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath })
      } catch (e: any) {
        // Branch já existe, apenas faz checkout
        if (!e.message.includes('already exists')) {
          throw e
        }
      }

      // Cria worktree
      await execAsync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoPath })

      context.logger?.info('Worktree criado', { worktreePath })

      return { success: true, data: { worktreePath, branchName } }
    } catch (error: any) {
      return { success: false, error: `Erro ao criar worktree: ${error.message}` }
    }
  },
}

/**
 * remove_worktree - Remove worktree
 */
export const removeWorktree: PrimitiveDefinition = {
  code: 'remove_worktree',
  name: 'Remover worktree',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { repoPath, worktreePath } = context

      context.logger?.info('Removendo worktree', { worktreePath })

      await execAsync(`git worktree remove --force ${worktreePath}`, { cwd: repoPath })

      context.logger?.info('Worktree removido', { worktreePath })

      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Erro ao remover worktree: ${error.message}` }
    }
  },
}

/**
 * install_dependencies - Instala dependências (npm ci)
 */
export const installDependencies: PrimitiveDefinition = {
  code: 'install_dependencies',
  name: 'Instalar dependências (npm ci)',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { worktreePath } = context
      const command = params?.command || 'npm ci'

      context.logger?.info('Instalando dependências', { worktreePath, command })

      const { stdout, stderr } = await execAsync(command, {
        cwd: worktreePath,
        timeout: 300000, // 5 minutos
      })

      context.logger?.info('Dependências instaladas', { worktreePath })

      return { success: true, data: { stdout, stderr } }
    } catch (error: any) {
      return { success: false, error: `Erro ao instalar dependências: ${error.message}` }
    }
  },
}

/**
 * verify_git - Verifica git status/diff
 */
export const verifyGit: PrimitiveDefinition = {
  code: 'verify_git',
  name: 'Verificar git status/diff',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { worktreePath } = context

      const { stdout: status } = await execAsync('git status --porcelain', { cwd: worktreePath })
      const { stdout: diff } = await execAsync('git diff --stat', { cwd: worktreePath })

      const hasChanges = status.trim().length > 0

      context.logger?.info('Git verificado', { worktreePath, hasChanges })

      return {
        success: true,
        data: { hasChanges, status, diff },
      }
    } catch (error: any) {
      return { success: false, error: `Erro ao verificar git: ${error.message}` }
    }
  },
}

/**
 * run_build - Roda build + testes
 */
export const runBuild: PrimitiveDefinition = {
  code: 'run_build',
  name: 'Rodar build + testes',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { worktreePath } = context
      const buildCommand = params?.buildCommand || 'npm run build'
      const testCommand = params?.testCommand || 'npm test'

      context.logger?.info('Rodando build', { worktreePath, buildCommand })

      // Build
      const { stdout: buildOut, stderr: buildErr } = await execAsync(buildCommand, {
        cwd: worktreePath,
        timeout: 300000,
      })

      // Testes
      context.logger?.info('Rodando testes', { worktreePath, testCommand })
      const { stdout: testOut, stderr: testErr } = await execAsync(testCommand, {
        cwd: worktreePath,
        timeout: 300000,
      })

      context.logger?.info('Build e testes passaram', { worktreePath })

      return {
        success: true,
        data: { buildOut, buildErr, testOut, testErr },
      }
    } catch (error: any) {
      return {
        success: false,
        error: `Build/testes falharam: ${error.message}`,
        data: { stdout: error.stdout, stderr: error.stderr },
      }
    }
  },
}

/**
 * commit_changes - Commit na branch da subtarefa
 */
export const commitChanges: PrimitiveDefinition = {
  code: 'commit_changes',
  name: 'Commit na branch da subtarefa',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { worktreePath, taskId, subtaskId } = context
      const message = params?.message || `task-${taskId}-sub-${subtaskId}: alterações automáticas`

      context.logger?.info('Commitando mudanças', { worktreePath, message })

      await execAsync('git add -A', { cwd: worktreePath })
      const { stdout } = await execAsync(`git commit -m "${message}"`, { cwd: worktreePath })

      // Extrai hash do commit
      const { stdout: commitHash } = await execAsync('git rev-parse HEAD', { cwd: worktreePath })

      context.logger?.info('Commit criado', { worktreePath, commitHash: commitHash.trim() })

      return { success: true, data: { commitHash: commitHash.trim(), message } }
    } catch (error: any) {
      return { success: false, error: `Erro ao commitar: ${error.message}` }
    }
  },
}

/**
 * merge_branch - Merge na branch da tarefa
 */
export const mergeBranch: PrimitiveDefinition = {
  code: 'merge_branch',
  name: 'Merge na branch da tarefa',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { repoPath, worktreePath, branchName } = context
      const targetBranch = params?.targetBranch || 'main'

      context.logger?.info('Fazendo merge', { from: branchName, to: targetBranch })

      // Checkout target branch
      await execAsync(`git checkout ${targetBranch}`, { cwd: repoPath })

      // Merge
      await execAsync(`git merge ${branchName} --no-ff -m "Merge ${branchName} into ${targetBranch}"`, {
        cwd: repoPath,
      })

      context.logger?.info('Merge completo', { from: branchName, to: targetBranch })

      return { success: true, data: { from: branchName, to: targetBranch } }
    } catch (error: any) {
      return { success: false, error: `Erro ao fazer merge: ${error.message}` }
    }
  },
}

/**
 * revert_merge - Reverte merge
 */
export const revertMerge: PrimitiveDefinition = {
  code: 'revert_merge',
  name: 'Reverter merge',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { repoPath } = context
      const commitHash = params?.commitHash

      if (!commitHash) {
        return { success: false, error: 'Parâmetro "commitHash" é obrigatório' }
      }

      context.logger?.info('Revertendo merge', { commitHash })

      await execAsync(`git revert --no-edit ${commitHash}`, { cwd: repoPath })

      context.logger?.info('Merge revertido', { commitHash })

      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Erro ao reverter merge: ${error.message}` }
    }
  },
}

/**
 * publish_branch - Push da branch da tarefa
 */
export const publishBranch: PrimitiveDefinition = {
  code: 'publish_branch',
  name: 'Push da branch da tarefa',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { repoPath, branchName } = context

      context.logger?.info('Publicando branch', { branchName })

      await execAsync(`git push origin ${branchName}`, { cwd: repoPath })

      context.logger?.info('Branch publicada', { branchName })

      return { success: true, data: { branchName } }
    } catch (error: any) {
      return { success: false, error: `Erro ao publicar branch: ${error.message}` }
    }
  },
}

/**
 * promote_to_base - Promove para base (com lock de integração)
 */
export const promoteToBase: PrimitiveDefinition = {
  code: 'promote_to_base',
  name: 'Promover para base (lock)',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { repoPath, taskId, branchName } = context
      const baseBranch = params?.baseBranch || 'main'

      context.logger?.info('Promovendo para base', { taskId, branchName, baseBranch })

      // TODO: Implementar lock de integração (B07)
      // Por enquanto, faz merge direto

      await execAsync(`git checkout ${baseBranch}`, { cwd: repoPath })
      await execAsync(`git merge ${branchName} --no-ff -m "Promote ${branchName} to ${baseBranch}"`, {
        cwd: repoPath,
      })
      await execAsync(`git push origin ${baseBranch}`, { cwd: repoPath })

      context.logger?.info('Promoção completa', { taskId, branchName, baseBranch })

      return { success: true, data: { branchName, baseBranch } }
    } catch (error: any) {
      return { success: false, error: `Erro ao promover para base: ${error.message}` }
    }
  },
}

/**
 * check_paths - Valida paths permitidos
 */
export const checkPaths: PrimitiveDefinition = {
  code: 'check_paths',
  name: 'Validar paths permitidos',
  domain: 'git',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const { worktreePath } = context
      const allowedPaths = params?.allowedPaths || []

      if (allowedPaths.length === 0) {
        return { success: true, data: { valid: true, message: 'Sem restrições de path' } }
      }

      const { stdout: changedFiles } = await execAsync('git diff --name-only', { cwd: worktreePath })

      const files = changedFiles.trim().split('\n').filter(f => f)
      const violations = files.filter(file => {
        return !allowedPaths.some((allowed: string) => file.startsWith(allowed))
      })

      const valid = violations.length === 0

      context.logger?.info('Paths verificados', { worktreePath, valid, violations })

      return {
        success: true,
        data: { valid, violations },
      }
    } catch (error: any) {
      return { success: false, error: `Erro ao verificar paths: ${error.message}` }
    }
  },
}
