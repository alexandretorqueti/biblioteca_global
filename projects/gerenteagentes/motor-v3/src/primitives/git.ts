/**
 * Primitivas de git (worktree, commit, merge, etc)
 */

import type { PrimitiveDefinition, PrimitiveContext, PrimitiveResult } from './types.js'
import { exec } from 'child_process'
import { existsSync } from 'node:fs'
import { readFile, rename as fsRename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'util'
import { mergeJournals, parseJournal } from '../deploy/MigrationJournalMerge.js'

const execAsync = promisify(exec)

const DEFAULT_MIGRATION_JOURNAL = 'projects/gerenteagentes/migrations/meta/_journal.json'

function journalRawParam(params: Record<string, any>, names: string[]): string | null | undefined {
  for (const name of names) {
    if (name in params) return params[name] as string | null | undefined
  }
  return undefined
}

async function readJournal(
  worktreePath: string,
  raw: string | null | undefined,
  path: string,
): Promise<string | null> {
  if (raw !== undefined) return raw
  try {
    return await readFile(resolve(worktreePath, path), 'utf8')
  } catch {
    return null
  }
}

/**
 * Renumera migrations de um membro quando o índice já está ocupado na base.
 * A composição do journal permanece centralizada em MigrationJournalMerge;
 * esta primitiva apenas aplica os renomeios coordenados no worktree.
 */
export const renumberMigration: PrimitiveDefinition = {
  code: 'renumber_migration',
  name: 'Renumera migration em colisão de journal',
  domain: 'git',
  handler: async (context: PrimitiveContext, params: Record<string, any> = {}): Promise<PrimitiveResult> => {
    const journalPath = String(params.journalPath ?? DEFAULT_MIGRATION_JOURNAL)
    const worktreePath = context.worktreePath
    try {
      const basePath = String(params.baseJournalPath ?? journalPath)
      const theirsPath = String(params.memberJournalPath ?? journalPath)
      const [oursRaw, baseRaw, theirsRaw] = await Promise.all([
        readJournal(worktreePath, journalRawParam(params, ['oursJournal', 'oursRaw']), journalPath),
        readJournal(worktreePath, journalRawParam(params, ['baseJournal', 'baseRaw']), basePath),
        readJournal(worktreePath, journalRawParam(params, ['theirsJournal', 'theirsRaw', 'memberJournal']), theirsPath),
      ])
      const ours = parseJournal(oursRaw)
      const base = parseJournal(baseRaw)
      const theirs = parseJournal(theirsRaw)
      if (!ours || !theirs) {
        return { success: false, error: 'Journals ours/theirs inválidos ou ausentes' }
      }

      const baseTags = new Set((base?.entries ?? []).map(entry => entry.tag))
      const oursTags = new Set(ours.entries.map(entry => entry.tag))
      const occupiedIndexes = new Map(ours.entries.map(entry => [entry.idx, entry.tag]))
      const hasCollision = theirs.entries.some(entry => {
        if (baseTags.has(entry.tag) || oursTags.has(entry.tag)) return false
        const occupiedTag = occupiedIndexes.get(entry.idx)
        return occupiedTag !== undefined && occupiedTag !== entry.tag
      })
      if (!hasCollision) {
        return { success: true, data: { changed: false, reason: 'no_collision', journalPath } }
      }

      const merged = mergeJournals(oursRaw, baseRaw, theirsRaw)
      if (!merged) return { success: false, error: 'Não foi possível combinar os journals' }

      const metaDir = dirname(journalPath)
      const migrationsDir = dirname(metaDir)
      const appliedRenames: Array<{ from: string; to: string; oldIdx: number; newIdx: number }> = []
      for (const rename of merged.renames) {
        const oldPrefix = String(rename.oldIdx).padStart(4, '0')
        const newPrefix = String(rename.newIdx).padStart(4, '0')
        const pairs: Array<[string, string, boolean]> = [
          [`${migrationsDir}/${rename.from}.sql`, `${migrationsDir}/${rename.to}.sql`, false],
          [`${metaDir}/${oldPrefix}_snapshot.json`, `${metaDir}/${newPrefix}_snapshot.json`, true],
        ]
        for (const [oldPath, newPath, optional] of pairs) {
          const absoluteOld = resolve(worktreePath, oldPath)
          const absoluteNew = resolve(worktreePath, newPath)
          if (optional && !existsSync(absoluteOld)) continue
          if (!existsSync(absoluteOld)) return { success: false, error: `Arquivo da migration ausente: ${oldPath}` }
          if (existsSync(absoluteNew)) return { success: false, error: `Alvo da renumeração ocupado: ${newPath}` }
          await fsRename(absoluteOld, absoluteNew)
        }
        appliedRenames.push(rename)
      }
      await writeFile(resolve(worktreePath, journalPath), `${JSON.stringify(merged.journal, null, 2)}\n`)
      context.logger?.info('Migration renumerada', { journalPath, renames: appliedRenames })
      return { success: true, data: { changed: true, journalPath, renames: appliedRenames } }
    } catch (error) {
      return { success: false, error: `Erro ao renumerar migration: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

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
