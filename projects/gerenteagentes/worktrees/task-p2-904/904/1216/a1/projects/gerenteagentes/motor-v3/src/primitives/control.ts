/**
 * Primitivas de controle
 */

import type { PrimitiveDefinition, PrimitiveContext, PrimitiveResult } from './types.js'

/**
 * set_flag - Seta uma flag no contexto da tarefa
 * Usado para controlar fluxo (retry, return_subtask, integrated, etc)
 */
export const setFlag: PrimitiveDefinition = {
  code: 'set_flag',
  name: 'Setar flag no contexto',
  domain: 'control',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    if (!params?.flag) {
      return { success: false, error: 'Parâmetro "flag" é obrigatório' }
    }

    const flagName = params.flag
    const flagValue = params.value ?? true

    // TODO: Implementar storage de flags (pode ser no banco ou em memória)
    // Por enquanto, apenas loga
    context.logger?.info(`[set_flag] ${flagName} = ${flagValue}`, {
      taskId: context.taskId,
      subtaskId: context.subtaskId,
    })

    return { success: true, data: { flag: flagName, value: flagValue } }
  },
}

/**
 * log - Registra log estruturado
 */
export const log: PrimitiveDefinition = {
  code: 'log',
  name: 'Registrar log estruturado',
  domain: 'control',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    const level = params?.level || 'info'
    const message = params?.message || 'Ação executada'

    const logData = {
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      executionId: context.executionId,
      generation: context.generation,
      ...params?.extra,
    }

    switch (level) {
      case 'error':
        context.logger?.error(message, logData)
        break
      case 'warn':
        context.logger?.warn(message, logData)
        break
      case 'info':
      default:
        context.logger?.info(message, logData)
        break
    }

    return { success: true }
  },
}
