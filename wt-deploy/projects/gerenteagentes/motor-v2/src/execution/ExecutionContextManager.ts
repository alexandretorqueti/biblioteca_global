/**
 * ExecutionContextManager - Contexto isolado via AsyncLocalStorage
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExecutionContext } from '../shared/types/execution.js'

class ExecutionContextManager {
  private storage = new AsyncLocalStorage<ExecutionContext>()

  async run<T>(context: ExecutionContext, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(context, fn)
  }

  getContext(): ExecutionContext | null {
    return this.storage.getStore() ?? null
  }

  requireContext(): ExecutionContext {
    const context = this.getContext()
    if (!context) {
      throw new Error('ExecutionContext não disponível')
    }
    return context
  }
}

export const executionContextManager = new ExecutionContextManager()

export function getCurrentContext(): ExecutionContext | null {
  return executionContextManager.getContext()
}

export function requireCurrentContext(): ExecutionContext {
  return executionContextManager.requireContext()
}
