/**
 * Bookkeeper — gerencia operações git após execução bem-sucedida
 * 
 * F3: Bookkeeper
 * - commit_changes (na branch da subtarefa)
 * - merge_branch (na branch da tarefa)
 * - publish_branch (push da branch da tarefa)
 * - promote_to_base (com lock de integração — B07)
 * - enqueue_deploy (enfileira para deploy)
 * 
 * Lock de integração (B07): garante que apenas uma tarefa por projeto
 * está em promoção simultaneamente, evitando conflitos de merge.
 */

import type { PrimitiveContext } from '../primitives/types.js'
import { commitChanges, mergeBranch, publishBranch, promoteToBase, enqueueDeploy } from '../primitives/index.js'

export interface BookkeeperConfig {
  lockTimeoutMs: number // Timeout do lock de integração
}

export interface BookkeeperResult {
  success: boolean
  commitHash?: string
  error?: string
}

export class Bookkeeper {
  private config: BookkeeperConfig
  private activeLocks = new Map<string, { taskId: string; acquiredAt: number }>()

  constructor(config: Partial<BookkeeperConfig> = {}) {
    this.config = {
      lockTimeoutMs: config.lockTimeoutMs ?? 300000, // 5 minutos
    }
  }

  /**
   * Commit das mudanças na branch da subtarefa
   */
  async commit(context: PrimitiveContext, message?: string): Promise<BookkeeperResult> {
    const result = await commitChanges.handler(context, { message })
    
    if (!result.success) {
      return { success: false, error: result.error }
    }

    return {
      success: true,
      commitHash: result.data?.commitHash,
    }
  }

  /**
   * Merge da branch da subtarefa na branch da tarefa
   */
  async merge(context: PrimitiveContext): Promise<BookkeeperResult> {
    const result = await mergeBranch.handler(context, {
      sourceBranch: context.branchName,
      targetBranch: `motor-v3/task-${context.taskId}`,
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return { success: true }
  }

  /**
   * Push da branch da tarefa para o repositório remoto
   */
  async publish(context: PrimitiveContext): Promise<BookkeeperResult> {
    const result = await publishBranch.handler(context, {
      branchName: `motor-v3/task-${context.taskId}`,
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return { success: true }
  }

  /**
   * Promove branch da tarefa para base (com lock de integração — B07)
   */
  async promote(context: PrimitiveContext): Promise<BookkeeperResult> {
    const projectSlug = context.projectSlug

    // Tenta adquirir lock
    if (!this.acquireLock(projectSlug, context.taskId)) {
      return {
        success: false,
        error: `Lock de integração já adquirido por outra tarefa no projeto ${projectSlug}`,
      }
    }

    try {
      const result = await promoteToBase.handler(context, {
        baseBranch: 'main',
      })

      if (!result.success) {
        return { success: false, error: result.error }
      }

      return { success: true }
    } finally {
      // Sempre libera o lock
      this.releaseLock(projectSlug)
    }
  }

  /**
   * Enfileira deploy da tarefa promovida
   */
  async enqueueDeploy(context: PrimitiveContext): Promise<BookkeeperResult> {
    const result = await enqueueDeploy.handler(context, {
      type: 'standard',
    })

    if (!result.success) {
      return { success: false, error: result.error }
    }

    return { success: true }
  }

  /**
   * Fluxo completo: commit → merge → publish → promote → deploy
   */
  async fullFlow(context: PrimitiveContext, commitMessage?: string): Promise<BookkeeperResult> {
    // 1. Commit
    const commitResult = await this.commit(context, commitMessage)
    if (!commitResult.success) {
      return commitResult
    }

    // 2. Merge
    const mergeResult = await this.merge(context)
    if (!mergeResult.success) {
      return mergeResult
    }

    // 3. Publish
    const publishResult = await this.publish(context)
    if (!publishResult.success) {
      return publishResult
    }

    // 4. Promote (com lock)
    const promoteResult = await this.promote(context)
    if (!promoteResult.success) {
      return promoteResult
    }

    // 5. Enqueue deploy
    const deployResult = await this.enqueueDeploy(context)
    if (!deployResult.success) {
      return deployResult
    }

    return {
      success: true,
      commitHash: commitResult.commitHash,
    }
  }

  /**
   * Adquire lock de integração para o projeto
   */
  private acquireLock(projectSlug: string, taskId: string): boolean {
    const existing = this.activeLocks.get(projectSlug)

    if (existing) {
      // Verifica se lock expirou
      const elapsed = Date.now() - existing.acquiredAt
      if (elapsed < this.config.lockTimeoutMs) {
        // Lock ainda válido
        return false
      }
      // Lock expirou, pode sobrescrever
    }

    this.activeLocks.set(projectSlug, {
      taskId,
      acquiredAt: Date.now(),
    })

    return true
  }

  /**
   * Libera lock de integração
   */
  private releaseLock(projectSlug: string): void {
    this.activeLocks.delete(projectSlug)
  }
}
