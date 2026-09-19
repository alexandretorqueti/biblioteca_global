/**
 * WorkerLauncher — lança agente em sandbox para executar tarefa
 * 
 * F3: Worker conversacional
 * - Lança agente OpenClaw em sandbox (opção a: raiz de worktrees montada)
 * - Protocolo ::DONE:: (detecta marcador na resposta)
 * - Verificação de realidade (verify_git + run_build)
 * - Gerencia ciclo de vida da sessão (create → send → wait → verify)
 */

import type { PrimitiveContext } from '../primitives/types.js'
import { createSession, sendMessage, waitForCompletion, parseReply, verifyGit, runBuild } from '../primitives/index.js'

export interface WorkerLauncherConfig {
  maxAttempts: number // Teto de tentativas (D6: local 2, cloud 3)
  timeoutMs: number // Timeout por tentativa
  sandboxRoot: string // Raiz de worktrees montada (opção a)
}

export interface WorkerResult {
  success: boolean
  response?: string
  hasChanges?: boolean
  buildPassed?: boolean
  error?: string
  attempts: number
}

export class WorkerLauncher {
  private config: WorkerLauncherConfig

  constructor(config: Partial<WorkerLauncherConfig> = {}) {
    this.config = {
      maxAttempts: config.maxAttempts ?? 3,
      timeoutMs: config.timeoutMs ?? 300000, // 5 minutos
      sandboxRoot: config.sandboxRoot ?? '/data/workspace/agentes/motor-v3/worktrees',
    }
  }

  /**
   * Executa tarefa completa: create session → send message → wait → verify
   */
  async executeTask(
    context: PrimitiveContext,
    taskDescription: string
  ): Promise<WorkerResult> {
    let attempts = 0

    while (attempts < this.config.maxAttempts) {
      attempts++

      try {
        // 1. Criar sessão
        const sessionResult = await createSession.handler(context, {
          sandboxRoot: this.config.sandboxRoot,
        })

        if (!sessionResult.success) {
          context.logger?.error('Falha ao criar sessão', { error: sessionResult.error })
          continue
        }

        // 2. Enviar mensagem com descrição da tarefa
        const sendResult = await sendMessage.handler(context, {
          message: taskDescription,
        })

        if (!sendResult.success) {
          context.logger?.error('Falha ao enviar mensagem', { error: sendResult.error })
          continue
        }

        // 3. Aguardar conclusão com timeout
        const waitResult = await waitForCompletion.handler(context, {
          timeoutMs: this.config.timeoutMs,
        })

        if (!waitResult.success) {
          context.logger?.error('Timeout ou erro ao aguardar', { error: waitResult.error })
          continue
        }

        const response = waitResult.data?.response ?? ''

        // 4. Parse da resposta (detecta ::DONE::)
        const parseResult = await parseReply.handler(context, { response })

        if (!parseResult.success) {
          context.logger?.error('Falha ao parsear resposta', { error: parseResult.error })
          continue
        }

        const hasDoneMarker = parseResult.data?.hasDoneMarker ?? false

        // 5. Verificação de realidade (se tiver ::DONE::)
        if (hasDoneMarker) {
          const verifyResult = await verifyGit.handler(context, {})

          if (!verifyResult.success) {
            context.logger?.error('Falha ao verificar git', { error: verifyResult.error })
            continue
          }

          const hasChanges = verifyResult.data?.hasChanges ?? false

          // Se não tem mudanças, falha (agente mentiu ou não fez nada)
          if (!hasChanges) {
            context.logger?.warn('Agente disse ::DONE:: mas não há mudanças no git')
            continue
          }

          // 6. Rodar build + testes
          const buildResult = await runBuild.handler(context, {})

          const buildPassed = buildResult.success

          if (!buildPassed) {
            context.logger?.warn('Build falhou', { error: buildResult.error })
            // Continua para próxima tentativa (agente pode corrigir)
            continue
          }

          // Sucesso!
          context.logger?.info('Tarefa executada com sucesso', { attempts })
          return {
            success: true,
            response,
            hasChanges,
            buildPassed,
            attempts,
          }
        } else {
          // Sem ::DONE::, agente ainda não terminou
          context.logger?.info('Agente não indicou conclusão, tentando novamente', { attempts })
          continue
        }
      } catch (error: any) {
        context.logger?.error('Erro inesperado', { error: error.message, attempts })
        attempts++
      }
    }

    // Esgotou tentativas
    context.logger?.error('Esgotado número máximo de tentativas', { maxAttempts: this.config.maxAttempts })
    return {
      success: false,
      error: `Esgotado número máximo de tentativas (${this.config.maxAttempts})`,
      attempts,
    }
  }
}
