import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type GitOperation = 'cherry-pick' | 'merge' | 'rebase'
export type GitOperationMarker = 'CHERRY_PICK_HEAD' | 'MERGE_HEAD' | 'REBASE_HEAD'

export interface GitOperationState {
  operation: GitOperation
  marker: GitOperationMarker
  markerPath: string
  conflictFiles: string[]
  command: string
}

/** Erro acionável: o worktree foi deixado em conflito real e precisa de intervenção. */
export class GitOperationBlockedError extends Error {
  constructor(public readonly state: GitOperationState, public readonly conflictFiles: string[], message?: string) {
    super(message ?? `Operação Git ${state.marker} bloqueada; resolva ou descarte os arquivos: ${conflictFiles.join(', ') || '(estado pendente)'}`)
    this.name = 'GitOperationBlockedError'
  }
}

const OPERATIONS: Array<{ marker: GitOperationMarker; operation: GitOperation; command: string }> = [
  { marker: 'CHERRY_PICK_HEAD', operation: 'cherry-pick', command: 'cherry-pick' },
  { marker: 'MERGE_HEAD', operation: 'merge', command: 'merge' },
  { marker: 'REBASE_HEAD', operation: 'rebase', command: 'rebase' },
]

/** Detecta e recupera estados Git deixados por uma execução interrompida. */
export class GitOperationStateDetector {
  async detect(repoPath: string): Promise<GitOperationState | null> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, encoding: 'utf8' })
    const gitDir = isAbsolute(stdout.trim()) ? stdout.trim() : resolve(repoPath, stdout.trim())
    for (const candidate of OPERATIONS) {
      const markerPath = resolve(gitDir, candidate.marker)
      try {
        await access(markerPath)
        return { ...candidate, markerPath, conflictFiles: await this.conflictFiles(repoPath) }
      } catch {
        // Ausência do marcador é o estado normal; testar o próximo tipo.
      }
    }
    return null
  }

  /** Aborta a operação pendente. Sem operação pendente, é um no-op idempotente. */
  async abort(repoPath: string): Promise<boolean> {
    const state = await this.detect(repoPath)
    if (!state) return false
    await this.runRecoveryCommand(repoPath, state, 'abort')
    return true
  }

  /** Continua a operação pendente. Sem operação pendente, é um no-op idempotente. */
  async continue(repoPath: string): Promise<boolean> {
    const state = await this.detect(repoPath)
    if (!state) return false
    await this.runRecoveryCommand(repoPath, state, 'continue')
    return true
  }

  /** Recupera estado pendente; cherry-pick noop é descartado, conflito real bloqueia. */
  async recover(repoPath: string): Promise<'none' | 'continued' | 'skipped'> {
    const state = await this.detect(repoPath)
    if (!state) return 'none'
    try {
      await this.continue(repoPath)
      return 'continued'
    } catch (error) {
      const conflicts = await this.conflictFiles(repoPath)
      if (state.operation === 'cherry-pick' && await this.isNoopConflict(repoPath, conflicts)) {
        try {
          await execFileAsync('git', ['cherry-pick', '--skip'], { cwd: repoPath })
          return 'skipped'
        } catch {
          // Um marcador órfão não é um cherry-pick válido; cai no bloqueio abaixo.
        }
      }
      await this.abort(repoPath).catch(() => undefined)
      const detail = error instanceof Error ? error.message : String(error)
      throw new GitOperationBlockedError(state, conflicts, `${detail}; ${state.marker} requer resolução manual${conflicts.length ? ` (${conflicts.join(', ')})` : ''}`)
    }
  }

  private async runRecoveryCommand(repoPath: string, state: GitOperationState, action: 'abort' | 'continue'): Promise<void> {
    try {
      await execFileAsync('git', [state.command, `--${action}`], { cwd: repoPath })
    } catch (error) {
      if (!await this.detect(repoPath)) return
      throw error
    }
  }

  private async conflictFiles(repoPath: string): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoPath, encoding: 'utf8' })
    return stdout.split('\n').map(file => file.trim()).filter(Boolean)
  }

  private async isNoopConflict(repoPath: string, conflicts: string[]): Promise<boolean> {
    if (conflicts.length) {
      await execFileAsync('git', ['checkout', '--ours', '--', '.'], { cwd: repoPath })
      await execFileAsync('git', ['add', '--update', '--', '.'], { cwd: repoPath })
    }
    return execFileAsync('git', ['diff', '--cached', '--quiet', 'HEAD'], { cwd: repoPath }).then(() => true, () => false)
  }
}
