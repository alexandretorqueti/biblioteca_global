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
  model?: string
  failures?: Array<{ attempt: number; model?: string; error: string }>
}

/** Missão do programador, com contexto longo separado do comando principal. */
export interface DevelopmentPrompt {
  header: string
  context: string | null
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
    taskDescription: string | DevelopmentPrompt,
    models: readonly string[] = [],
    onModelFailure?: (model: string, error: string) => Promise<void>,
  ): Promise<WorkerResult> {
    let attempts = 0
    let lastError = 'Nenhuma tentativa foi executada'
    let lastModel: string | undefined
    const failures: Array<{ attempt: number; model?: string; error: string }> = []
    // Sem configuração explícita, preserva o comportamento do Console. Com
    // cadeia configurada, cada tentativa recebe seu modelo e sua sessão própria.
    const candidates = models.length > 0 ? models : [undefined]
    const maximumAttempts = models.length > 0
      ? Math.min(this.config.maxAttempts, candidates.length)
      : this.config.maxAttempts

    while (attempts < maximumAttempts) {
      const model = candidates[attempts] ?? candidates[candidates.length - 1]
      attempts++
      lastModel = model
      context.model = model
      context.sessionId = undefined

      try {
        // 1. Criar sessão
        const sessionResult = await createSession.handler(context, {
          sandboxRoot: this.config.sandboxRoot,
        })

        if (!sessionResult.success) {
          context.logger?.error('Falha ao criar sessão', { error: sessionResult.error })
          lastError = sessionResult.error ?? 'Falha ao criar sessão'
          failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
          await this.recordModelFailure(model, lastError, onModelFailure)
          context.generation++
          continue
        }

        // 2. Contextos longos são enviados antes do comando principal, como no
        // v2. O header é a mensagem que dispara a execução do programador.
        const prompt = normalizePrompt(taskDescription)
        if (prompt.context) {
          const contextResult = await sendMessage.handler(context, { message: prompt.context })
          if (!contextResult.success) {
            context.logger?.error('Falha ao enviar contexto da tarefa', { error: contextResult.error })
            lastError = contextResult.error ?? 'Falha ao enviar contexto da tarefa'
            failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
            await this.recordModelFailure(model, lastError, onModelFailure)
            context.generation++
            continue
          }
        }

        // 3. Enviar o comando principal da tarefa
        const sendResult = await sendMessage.handler(context, {
          message: prompt.header,
        })

        if (!sendResult.success) {
          context.logger?.error('Falha ao enviar mensagem', { error: sendResult.error })
          lastError = sendResult.error ?? 'Falha ao enviar mensagem'
          failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
          await this.recordModelFailure(model, lastError, onModelFailure)
          context.generation++
          continue
        }

        // 4. Aguardar conclusão com timeout
        const waitResult = await waitForCompletion.handler(context, {
          timeoutMs: this.config.timeoutMs,
        })

        if (!waitResult.success) {
          context.logger?.error('Timeout ou erro ao aguardar', { error: waitResult.error })
          lastError = waitResult.error ?? 'Falha aguardando o programador'
          failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
          await this.recordModelFailure(model, lastError, onModelFailure)
          context.generation++
          continue
        }

        const response = waitResult.data?.response ?? ''

        // 5. Parse da resposta (detecta ::DONE::)
        const parseResult = await parseReply.handler(context, { response })

        if (!parseResult.success) {
          context.logger?.error('Falha ao parsear resposta', { error: parseResult.error })
          lastError = parseResult.error ?? 'Falha ao interpretar resposta do programador'
          failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
          context.generation++
          continue
        }

        const hasDoneMarker = parseResult.data?.hasDoneMarker ?? false

        // 6. Verificação de realidade (se tiver ::DONE::)
        if (hasDoneMarker) {
          const verifyResult = await verifyGit.handler(context, {})

          if (!verifyResult.success) {
            context.logger?.error('Falha ao verificar git', { error: verifyResult.error })
            lastError = verifyResult.error ?? 'Falha ao verificar alterações Git'
            failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
            context.generation++
            continue
          }

          const hasChanges = verifyResult.data?.hasChanges ?? false

          // Se não tem mudanças, falha (agente mentiu ou não fez nada)
          if (!hasChanges) {
            context.logger?.warn('Agente disse ::DONE:: mas não há mudanças no git')
            lastError = 'O programador declarou conclusão, mas não alterou o worktree autorizado'
            failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
            context.generation++
            continue
          }

          // 7. Rodar build + testes
          const buildResult = await runBuild.handler(context, {
            buildCommand: context.buildCommand,
            testCommand: context.testCommand,
          })

          const buildPassed = buildResult.success

          if (!buildPassed) {
            context.logger?.warn('Build falhou', { error: buildResult.error })
            lastError = buildResult.error ?? 'Build ou testes falharam'
            failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
            context.generation++
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
            ...(model ? { model } : {}),
            ...(failures.length > 0 ? { failures } : {}),
          }
        } else {
          // Sem ::DONE::, agente ainda não terminou
          context.logger?.info('Agente não indicou conclusão, tentando novamente', { attempts })
          lastError = 'O programador encerrou sem o marcador ::DONE::'
          failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
          context.generation++
          continue
        }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error)
        failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
        context.logger?.error('Erro inesperado', { error: lastError, attempts })
        await this.recordModelFailure(model, lastError, onModelFailure)
        context.generation++
      }
    }

    // Esgotou tentativas
    context.logger?.error('Esgotado número máximo de tentativas', { maxAttempts: maximumAttempts })
    return {
      success: false,
      error: `Esgotado número máximo de tentativas (${maximumAttempts}): ${lastError}`,
      attempts,
      ...(lastModel ? { model: lastModel } : {}),
      failures,
    }
  }

  private async recordModelFailure(
    model: string | undefined,
    error: string,
    callback: ((model: string, error: string) => Promise<void>) | undefined,
  ): Promise<void> {
    if (!model || !callback) return
    if (!/(?:\b429\b|quota|rate[ -]?limit|credit|billing|model.+not found|indispon[ií]vel|SESSION_FAILED|agent run failed before producing)/i.test(error)) return
    try {
      await callback(model, error)
    } catch (callbackError) {
      // A telemetria/cooldown não pode impedir o failover para o próximo modelo.
      // O erro continua visível no logger da execução.
      const reason = callbackError instanceof Error ? callbackError.message : String(callbackError)
      console.warn('Falha ao registrar cooldown do modelo', { model, error: reason })
    }
  }
}

function normalizePrompt(prompt: string | DevelopmentPrompt): DevelopmentPrompt {
  return typeof prompt === 'string' ? { header: prompt, context: null } : prompt
}
