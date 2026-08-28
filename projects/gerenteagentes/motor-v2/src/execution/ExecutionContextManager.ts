/**
 * ExecutionContextManager - Gerenciamento de contexto de execução
 * 
 * Usa AsyncLocalStorage para propagar contexto sem variáveis globais.
 * Cada execução tem seu próprio contexto isolado.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExecutionContext } from '../shared/types/execution.js'

class ExecutionContextManager {
  private storage = new AsyncLocalStorage<ExecutionContext>()

  /**
   * Executa uma função dentro de um contexto de execução
   */
  async run<T>(context: ExecutionContext, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(context, fn)
  }

  /**
   * Obtém o contexto atual
   */
  getContext(): ExecutionContext | null {
    return this.storage.getStore() ?? null
  }

  /**
   * Obtém o contexto atual ou lança erro se não houver
   */
  requireContext(): ExecutionContext {
    const context = this.getContext()
    if (!context) {
      throw new Error('ExecutionContext não disponível. Certifique-se de que está dentro de uma execução.')
    }
    return context
  }

  /**
   * Atualiza o contexto atual (retorna novo contexto)
   */
  updateContext(updates: Partial<ExecutionContext>): ExecutionContext {
    const current = this.requireContext()
    const updated = { ...current, ...updates }
    
    // AsyncLocalStorage não permite atualização direta,
    // então precisamos criar um novo contexto
    // Isso será feito no próximo run()
    return updated
  }
}

// Singleton
export const executionContextManager = new ExecutionContextManager()

/**
 * Helper para obter contexto atual
 */
export function getCurrentContext(): ExecutionContext | null {
  return executionContextManager.getContext()
}

/**
 * Helper para obter contexto atual ou lançar erro
 */
export function requireCurrentContext(): ExecutionContext {
  return executionContextManager.requireContext()
}
