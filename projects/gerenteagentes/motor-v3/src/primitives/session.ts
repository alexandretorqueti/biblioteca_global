/**
 * Primitivas de sessão (interação com Console OpenClaw)
 */

import type { PrimitiveDefinition, PrimitiveContext, PrimitiveResult } from './types.js'

/**
 * create_session - Cria sessão no Console
 */
export const createSession: PrimitiveDefinition = {
  code: 'create_session',
  name: 'Criar sessão no Console',
  domain: 'session',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      if (!context.consoleApi) {
        return { success: false, error: 'Console API não disponível' }
      }

      // Extrai nome do modelo removendo prefixo do provider (ex.: openai/gpt-5.6-luna → gpt-5.6-luna)
      // Fallback para console-default quando context.model estiver ausente
      const modelName = context.model ? context.model.split('/').pop()! : 'console-default'
      const sessionKey = `dev-${modelName}-${context.taskId}-s${context.subtaskId}`
      
      const response = await context.consoleApi.createSession({
        key: sessionKey,
        agentId: context.agentId,
        ...(context.model ? { model: context.model } : {}),
        metadata: {
          taskId: context.taskId,
          databaseTaskId: context.databaseTaskId,
          subtaskId: context.subtaskId,
          executionId: context.executionId,
          generation: context.generation,
          baselineRunId: context.baselineRunId,
          worktreePath: context.worktreePath,
          branchName: context.branchName,
        },
      })

      context.sessionId = response.sessionId
      context.sessionKey = sessionKey
      context.logger?.info('Sessão criada', { sessionId: response.sessionId, sessionKey })

      return { success: true, data: { sessionId: response.sessionId, sessionKey } }
    } catch (error: any) {
      return { success: false, error: `Erro ao criar sessão: ${error.message}` }
    }
  },
}

/**
 * archive_session - Arquiva sessão física
 */
export const archiveSession: PrimitiveDefinition = {
  code: 'archive_session',
  name: 'Arquivar sessão física',
  domain: 'session',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      if (!context.consoleApi || !context.sessionId) {
        return { success: false, error: 'Console API ou sessionId não disponível' }
      }

      await context.consoleApi.archiveSession(context.sessionId)
      context.logger?.info('Sessão arquivada', { sessionId: context.sessionId })

      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Erro ao arquivar sessão: ${error.message}` }
    }
  },
}

/**
 * increment_generation - Incrementa geração da sessão
 */
export const incrementGeneration: PrimitiveDefinition = {
  code: 'increment_generation',
  name: 'Incrementar geração da sessão',
  domain: 'session',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    const oldGeneration = context.generation
    context.generation++
    
    context.logger?.info('Geração incrementada', {
      taskId: context.taskId,
      subtaskId: context.subtaskId,
      oldGeneration,
      newGeneration: context.generation,
    })

    return { success: true, data: { oldGeneration, newGeneration: context.generation } }
  },
}

/**
 * send_message - Envia mensagem ao modelo via Console
 */
export const sendMessage: PrimitiveDefinition = {
  code: 'send_message',
  name: 'Enviar mensagem ao modelo',
  domain: 'session',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      if (!context.consoleApi || !context.sessionId) {
        return { success: false, error: 'Console API ou sessionId não disponível' }
      }

      if (!params?.message) {
        return { success: false, error: 'Parâmetro "message" é obrigatório' }
      }

      await context.consoleApi.sendMessage({
        sessionId: context.sessionId,
        message: params.message,
      })

      context.logger?.info('Mensagem enviada', {
        sessionId: context.sessionId,
        messageLength: params.message.length,
      })

      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Erro ao enviar mensagem: ${error.message}` }
    }
  },
}

/**
 * send_feedback - Envia feedback corretivo ao modelo
 */
export const sendFeedback: PrimitiveDefinition = {
  code: 'send_feedback',
  name: 'Enviar feedback corretivo',
  domain: 'session',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      if (!context.consoleApi || !context.sessionId) {
        return { success: false, error: 'Console API ou sessionId não disponível' }
      }

      if (!params?.feedback) {
        return { success: false, error: 'Parâmetro "feedback" é obrigatório' }
      }

      await context.consoleApi.sendMessage({
        sessionId: context.sessionId,
        message: `[FEEDBACK] ${params.feedback}`,
      })

      context.logger?.info('Feedback enviado', {
        sessionId: context.sessionId,
        feedback: params.feedback.substring(0, 100),
      })

      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Erro ao enviar feedback: ${error.message}` }
    }
  },
}

/**
 * wait_for_completion - Aguarda fim do run
 */
export const waitForCompletion: PrimitiveDefinition = {
  code: 'wait_for_completion',
  name: 'Aguardar fim do run',
  domain: 'session',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      if (!context.consoleApi || !context.sessionId) {
        return { success: false, error: 'Console API ou sessionId não disponível' }
      }

      const timeout = params?.timeoutMs || 300000 // 5 minutos default
      const pollInterval = params?.pollIntervalMs || 5000

      const startTime = Date.now()

      while (Date.now() - startTime < timeout) {
        const status = await context.consoleApi.getSessionStatus(context.sessionId)
        
        if (status.isComplete) {
          context.logger?.info('Run completado', { sessionId: context.sessionId })
          return { success: true, data: { response: status.lastResponse } }
        }

        if (status.isFailed) {
          return { success: false, error: `Run falhou: ${status.error}` }
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval))
      }

      return { success: false, error: 'Timeout aguardando conclusão do run' }
    } catch (error: any) {
      return { success: false, error: `Erro ao aguardar conclusão: ${error.message}` }
    }
  },
}

/**
 * parse_reply - Parse da resposta do agente (detecta marcador ::DONE::)
 */
export const parseReply: PrimitiveDefinition = {
  code: 'parse_reply',
  name: 'Parse da resposta do agente',
  domain: 'session',
  handler: async (context: PrimitiveContext, params?: Record<string, any>): Promise<PrimitiveResult> => {
    try {
      const response = params?.response
      if (!response || typeof response !== 'string') {
        return { success: false, error: 'Parâmetro "response" inválido' }
      }

      // Detecta marcador ::DONE:: (D3)
      const donePattern = /::DONE::/i
      const hasDoneMarker = donePattern.test(response)

      context.logger?.info('Resposta parseada', {
        hasDoneMarker,
        responseLength: response.length,
      })

      return {
        success: true,
        data: {
          hasDoneMarker,
          response,
        },
      }
    } catch (error: any) {
      return { success: false, error: `Erro ao parsear resposta: ${error.message}` }
    }
  },
}
