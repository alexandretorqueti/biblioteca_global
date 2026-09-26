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
  baselineRunId?: number
  postDevRunId?: number
  preExistingFailureCount?: number
  resolvedFailureCount?: number
}

export interface DifferentialGateResult {
  success: boolean
  runId?: number
  error?: string
  newFailureCount?: number
  preExistingFailureCount?: number
  resolvedFailureCount?: number
  retryableByDeveloper?: boolean
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
    runDifferentialGate?: (context: PrimitiveContext, phase: 'post_dev' | 'rework') => Promise<DifferentialGateResult>,
    allowNoChanges = false,
  ): Promise<WorkerResult> {
    // Timeout global para toda a execução do worker (25 minutos por padrão).
    // Deve ser menor que o timeout do RabbitMQ (30 minutos) para evitar
    // PRECONDITION_FAILED - delivery acknowledgement timed out.
    const globalTimeoutMs = Number(process.env.MOTOR_WORKER_GLOBAL_TIMEOUT_MS ?? 1500000) // 25 min
    const globalStartTime = Date.now()
    
    let attempts = 0
    let lastError = 'Nenhuma tentativa foi executada'
    let lastModel: string | undefined
    const failures: Array<{ attempt: number; model?: string; error: string }> = []
    let correctiveContext = ''
    let reusableSessionModel: string | undefined
    // Sem configuração explícita, preserva o comportamento do Console. Com
    // cadeia configurada, cada tentativa recebe seu modelo e sua sessão própria.
    const candidates = models.length > 0 ? models : [undefined]
    // O número de modelos não limita rework. Depois de percorrer a cadeia,
    // o último modelo pode receber o diagnóstico das regressões e corrigi-las
    // até o teto operacional configurado.
    const maximumAttempts = this.config.maxAttempts

    while (attempts < maximumAttempts) {
      // Verifica timeout global
      const elapsedMs = Date.now() - globalStartTime
      if (elapsedMs > globalTimeoutMs) {
        context.logger?.warn(`[WorkerLauncher] Timeout global atingido (${Math.round(elapsedMs / 1000)}s > ${Math.round(globalTimeoutMs / 1000)}s)`)
        lastError = `Timeout global do worker atingido após ${Math.round(elapsedMs / 1000)}s (limite: ${Math.round(globalTimeoutMs / 1000)}s)`
        failures.push({ attempt: attempts, ...(lastModel ? { model: lastModel } : {}), error: lastError })
        break
      }
      
      const model = candidates[attempts] ?? candidates[candidates.length - 1]
      attempts++
      lastModel = model
      context.model = model
      const reuseSession = Boolean(correctiveContext && context.sessionId && reusableSessionModel === model)
      if (!reuseSession) context.sessionId = undefined

      try {
        // 1. Criar sessão
        const sessionResult = reuseSession
          ? { success: true as const }
          : await createSession.handler(context, { sandboxRoot: this.config.sandboxRoot })

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
          message: correctiveContext ? `${prompt.header}\n\nCORREÇÃO OBRIGATÓRIA DA TENTATIVA ANTERIOR:\n${correctiveContext}` : prompt.header,
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
            if (allowNoChanges) {
              return { success: true, response, hasChanges: false, buildPassed: true, attempts, ...(model ? { model } : {}) }
            }
            context.logger?.warn('Agente disse ::DONE:: mas não há mudanças no git')
            lastError = 'O programador declarou conclusão, mas não alterou o worktree autorizado'
            failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
            context.generation++
            continue
          }

          // 7. Rodar build + testes
          const buildResult = runDifferentialGate
            ? await runDifferentialGate(context, attempts === 1 ? 'post_dev' : 'rework')
            : await runBuild.handler(context, { buildCommand: context.buildCommand, testCommand: context.testCommand })

          const buildPassed = buildResult.success

          if (!buildPassed) {
            context.logger?.warn('Build falhou', { error: buildResult.error })
            lastError = buildResult.error ?? 'Build ou testes falharam'
            correctiveContext = lastError
            reusableSessionModel = model
            failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
            if ('retryableByDeveloper' in buildResult && buildResult.retryableByDeveloper === false) {
              return {
                success: false, error: lastError, attempts, hasChanges, buildPassed: false,
                ...(model ? { model } : {}), failures,
                ...(context.baselineRunId ? { baselineRunId: context.baselineRunId } : {}),
                ...('runId' in buildResult && buildResult.runId ? { postDevRunId: buildResult.runId } : {}),
              }
            }
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
            ...(context.baselineRunId ? { baselineRunId: context.baselineRunId } : {}),
            ...('runId' in buildResult && buildResult.runId ? { postDevRunId: buildResult.runId } : {}),
            ...('preExistingFailureCount' in buildResult && buildResult.preExistingFailureCount ? { preExistingFailureCount: buildResult.preExistingFailureCount } : {}),
            ...('resolvedFailureCount' in buildResult && buildResult.resolvedFailureCount ? { resolvedFailureCount: buildResult.resolvedFailureCount } : {}),
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

  /**
   * Finaliza uma execução cuja sessão sobreviveu ao restart do Motor.
   * Não envia prompt e não cria sessão: valida exatamente a resposta já
   * produzida pelo Console e executa os mesmos gates do fluxo normal.
   */
  async recoverCompletedTask(
    context: PrimitiveContext,
    response: string,
    runDifferentialGate?: (context: PrimitiveContext, phase: 'post_dev' | 'rework') => Promise<DifferentialGateResult>,
    allowNoChanges = false,
  ): Promise<WorkerResult> {
    const parseResult = await parseReply.handler(context, { response })
    if (!parseResult.success || !parseResult.data?.hasDoneMarker) {
      return {
        success: false,
        error: parseResult.error ?? 'A sessão recuperada terminou sem o marcador ::DONE::',
        attempts: 1,
        ...(context.model ? { model: context.model } : {}),
      }
    }

    const verifyResult = await verifyGit.handler(context, {})
    if (!verifyResult.success) {
      return {
        success: false,
        error: verifyResult.error ?? 'Falha ao verificar alterações Git da sessão recuperada',
        attempts: 1,
        ...(context.model ? { model: context.model } : {}),
      }
    }
    const hasChanges = verifyResult.data?.hasChanges ?? false
    if (!hasChanges && !allowNoChanges) {
      return {
        success: false,
        error: 'A sessão recuperada declarou conclusão, mas não alterou o worktree autorizado',
        attempts: 1,
        hasChanges: false,
        ...(context.model ? { model: context.model } : {}),
      }
    }
    if (!hasChanges && allowNoChanges) {
      return { success: true, response, attempts: 1, hasChanges: false, buildPassed: true, ...(context.model ? { model: context.model } : {}) }
    }

    const gate = runDifferentialGate
      ? await runDifferentialGate(context, 'post_dev')
      : await runBuild.handler(context, { buildCommand: context.buildCommand, testCommand: context.testCommand })
    if (!gate.success) {
      return {
        success: false,
        error: gate.error ?? 'Build ou testes falharam após recuperação da sessão',
        attempts: 1,
        hasChanges,
        buildPassed: false,
        ...(context.model ? { model: context.model } : {}),
        ...('runId' in gate && gate.runId ? { postDevRunId: gate.runId } : {}),
      }
    }
    return {
      success: true,
      response,
      attempts: 1,
      hasChanges,
      buildPassed: true,
      ...(context.model ? { model: context.model } : {}),
      ...(context.baselineRunId ? { baselineRunId: context.baselineRunId } : {}),
      ...('runId' in gate && gate.runId ? { postDevRunId: gate.runId } : {}),
      ...('preExistingFailureCount' in gate && gate.preExistingFailureCount ? { preExistingFailureCount: gate.preExistingFailureCount } : {}),
      ...('resolvedFailureCount' in gate && gate.resolvedFailureCount ? { resolvedFailureCount: gate.resolvedFailureCount } : {}),
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
