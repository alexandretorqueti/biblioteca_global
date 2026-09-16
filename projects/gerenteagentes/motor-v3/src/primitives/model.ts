/**
 * Primitivas de modelo (cooldown e escalada)
 */

import type { PrimitiveDefinition, PrimitiveContext, PrimitiveResult } from './types.js'

/**
 * cooldown_model - Coloca modelo em cooldown
 */
export const cooldownModel: PrimitiveDefinition = {
  code: 'cooldown_model',
  name: 'Colocar modelo em cooldown',
  domain: 'model',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const minutes = params?.minutes || 30
      const model = params?.model || 'default'

      // TODO: Implementar storage de cooldown (banco ou memória)
      // Por enquanto, apenas loga
      context.logger?.info('Modelo em cooldown', {
        taskId: context.taskId,
        model,
        minutes,
      })

      return {
        success: true,
        data: { model, minutes, cooldownUntil: new Date(Date.now() + minutes * 60000).toISOString() },
      }
    } catch (error: any) {
      return { success: false, error: `Erro ao colocar modelo em cooldown: ${error.message}` }
    }
  },
}

/**
 * escalate_model - Escala para próximo modelo
 */
export const escalateModel: PrimitiveDefinition = {
  code: 'escalate_model',
  name: 'Escalar para próximo modelo',
  domain: 'model',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const currentModel = params?.currentModel || 'unknown'
      const nextModel = params?.nextModel

      if (!nextModel) {
        return { success: false, error: 'Parâmetro "nextModel" é obrigatório' }
      }

      context.logger?.info('Modelo escalado', {
        taskId: context.taskId,
        from: currentModel,
        to: nextModel,
      })

      return {
        success: true,
        data: { from: currentModel, to: nextModel },
      }
    } catch (error: any) {
      return { success: false, error: `Erro ao escalar modelo: ${error.message}` }
    }
  },
}
