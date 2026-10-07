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
import type { GovernedFailureHandler } from '../governance/GovernedFailureHandler.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface WorkerLauncherConfig {
  maxAttempts: number // Teto de tentativas (D6: local 2, cloud 3)
  timeoutMs: number // Timeout por tentativa
  /** Limite total da execução, sempre menor que o timeout do broker. */
  globalTimeoutMs: number
  /** DEV pode entregar a sessão ao reconciliador em vez de encerrá-la por timeout. */
  handoffSessionOnTimeout: boolean
  sandboxRoot: string // Raiz de worktrees montada (opção a)
  /** Roteia a decisão terminal H6/H7 pelo catálogo quando fornecido. */
  governedFailureHandler?: GovernedFailureHandler
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
  /** A sessão remota permanece ativa e deve ser acompanhada pelo reconciliador. */
  sessionHandedOff?: boolean
  /** O DEV informou explicitamente que a tarefa não exigiu alterações de código (::NO_CHANGES::). */
  noChangesNeeded?: boolean
  /** Fallback legado: completion_kind ausente foi confirmado como sem alteração de código. */
  legacyNoCodeChange?: boolean
  wrongCheckoutDiagnostic?: WrongCheckoutDiagnostic
}

export interface WrongCheckoutDiagnostic {
  kind: 'main_repo_related_changes' | 'main_repo_unrelated_changes'
  files: string[]
  summary: string
  diffSummary: string
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
  scopeEvidence?: string[]
}

export class WorkerLauncher {
  private config: WorkerLauncherConfig

  constructor(config: Partial<WorkerLauncherConfig> = {}) {
    this.config = {
      maxAttempts: config.maxAttempts ?? 3,
      timeoutMs: config.timeoutMs ?? 4_800_000, // 80 minutos
      globalTimeoutMs: config.globalTimeoutMs ?? Number(process.env.MOTOR_WORKER_GLOBAL_TIMEOUT_MS ?? 5_100_000), // 85 minutos
      handoffSessionOnTimeout: config.handoffSessionOnTimeout ?? false,
      sandboxRoot: config.sandboxRoot ?? '/data/workspace/agentes/motor-v3/worktrees',
      governedFailureHandler: config.governedFailureHandler,
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
    deadlineAt?: number,
    allowLegacyNoCodeEvidence = false,
  ): Promise<WorkerResult> {
    // Deve ser menor que o timeout do RabbitMQ. A espera abaixo é limitada ao
    // orçamento restante da entrega, incluindo preparação e baseline.
    const externalBudgetMs = deadlineAt === undefined ? this.config.globalTimeoutMs : Math.max(1, deadlineAt - Date.now())
    const globalTimeoutMs = Math.min(this.config.globalTimeoutMs, externalBudgetMs)
    const globalStartTime = Date.now()
    
    let attempts = 0
    let lastError = 'Nenhuma tentativa foi executada'
    let lastModel: string | undefined
    const failures: Array<{ attempt: number; model?: string; error: string }> = []
    let correctiveContext = ''
    let continuationPrompt: string | null = null
    let wrongCheckoutDiagnostic: WrongCheckoutDiagnostic | undefined
    let reusableSessionModel: string | undefined
    let legacyEvidenceRebriefIssued = false
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
      const reuseSession = Boolean((correctiveContext || continuationPrompt) && context.sessionId && reusableSessionModel === model)
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
        if (prompt.context && !reuseSession) {
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
        const message = continuationPrompt
          ?? (correctiveContext
            ? `${prompt.header}\n\nCORREÇÃO OBRIGATÓRIA DA TENTATIVA ANTERIOR:\n${correctiveContext}`
            : prompt.header)
        const sendResult = await sendMessage.handler(context, { message })
        continuationPrompt = null

        if (!sendResult.success) {
          context.logger?.error('Falha ao enviar mensagem', { error: sendResult.error })
          lastError = sendResult.error ?? 'Falha ao enviar mensagem'
          failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
          await this.recordModelFailure(model, lastError, onModelFailure)
          context.generation++
          continue
        }

        // 4. Aguardar conclusão com timeout
        const remainingMs = globalTimeoutMs - (Date.now() - globalStartTime)
        if (remainingMs <= 0) {
          lastError = `Timeout global do worker atingido (limite: ${Math.round(globalTimeoutMs / 1000)}s)`
          break
        }
        const waitResult = await waitForCompletion.handler(context, {
          timeoutMs: Math.min(this.config.timeoutMs, remainingMs),
        })

        if (!waitResult.success) {
          if (this.config.handoffSessionOnTimeout && /timeout aguardando conclusão/i.test(waitResult.error ?? '')) {
            context.logger?.warn('Sessão DEV ainda ativa; transferindo acompanhamento ao reconciliador', {
              sessionId: context.sessionId,
              timeoutMs: Math.min(this.config.timeoutMs, remainingMs),
            })
            return {
              success: false,
              sessionHandedOff: true,
              error: waitResult.error ?? 'Timeout aguardando conclusão do run',
              attempts,
              ...(model ? { model } : {}),
            }
          }
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
        const noChangesNeeded = parseResult.data?.noChangesNeeded ?? false

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

          // Se não tem mudanças, verifica se o DEV informou explicitamente ::NO_CHANGES::
          if (!hasChanges) {
            // DEV informou que a tarefa não exigiu alterações de código — sucesso mesmo sem mudanças
            if (noChangesNeeded) {
              context.logger?.info('DEV informou ::NO_CHANGES:: — tarefa não exigiu alterações de código', { attempts })
              return { success: true, response, hasChanges: false, noChangesNeeded: true, buildPassed: true, attempts, ...(model ? { model } : {}) }
            }
            if (allowNoChanges) {
              return { success: true, response, hasChanges: false, buildPassed: true, attempts, ...(model ? { model } : {}) }
            }
            wrongCheckoutDiagnostic = await inspectMainRepository(context, normalizePrompt(taskDescription))
            // completion_kind NULL é legado. Só permite a conclusão sem diff
            // quando o checkout principal também está limpo e o DEV documenta
            // a validação na própria sessão (um único re-brief sem tentativa).
            if (allowLegacyNoCodeEvidence && !wrongCheckoutDiagnostic && await isMainRepositoryClean(context)) {
              if (!legacyEvidenceRebriefIssued) {
                legacyEvidenceRebriefIssued = true
                attempts--
                continuationPrompt = [
                  'A subtarefa legada não possui completion_kind e não houve alteração de código.',
                  'Relate agora, de forma objetiva, os comandos de validação executados e os respectivos resultados.',
                  'Não altere o código apenas para produzir diff. Inclua ::DONE:: ao final.',
                ].join('\n')
                reusableSessionModel = model
                continue
              }
              if (hasValidationEvidence(response)) {
                return {
                  success: true, response, hasChanges: false, noChangesNeeded: true, legacyNoCodeChange: true,
                  buildPassed: true, attempts, ...(model ? { model } : {}),
                }
              }
            }
            context.logger?.warn('Agente disse ::DONE:: mas não há mudanças no git')
            lastError = wrongCheckoutDiagnostic?.summary
              ?? 'O programador declarou conclusão, mas não alterou o worktree autorizado'
            failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
            correctiveContext = wrongCheckoutDiagnostic
              ? `${lastError}\nMova ou refaça as alterações exclusivamente no worktree autorizado: ${context.worktreePath}. Não edite o checkout principal (${context.repoPath}).`
              : ''
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
          // A sessão já contém o trabalho e o contexto. Nunca abrir outro DEV
          // apenas porque ele encerrou sem cumprir o protocolo de conclusão.
          // A próxima tentativa envia um pedido explícito à mesma sessão.
          context.logger?.info('Agente encerrou sem ::DONE::; solicitando conclusão na mesma sessão', { attempts })
          lastError = 'O programador encerrou sem o marcador ::DONE::'
          failures.push({ attempt: attempts, ...(model ? { model } : {}), error: lastError })
          const originalPrompt = normalizePrompt(taskDescription)
          continuationPrompt = [
            originalPrompt.context,
            originalPrompt.header,
            '',
            'A execução anterior foi encerrada sem o protocolo de conclusão.',
            `Revise o trabalho já feito no workspace ${context.worktreePath}, conclua as validações necessárias e responda com um resumo final.`,
            'Inclua obrigatoriamente o marcador ::DONE:: na resposta final.',
          ].filter((part): part is string => Boolean(part)).join('\n')
          reusableSessionModel = model
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
    await this.routeExhaustedFailure(context, lastError, attempts, maximumAttempts, wrongCheckoutDiagnostic)
    return {
      success: false,
      error: `Esgotado número máximo de tentativas (${maximumAttempts}): ${lastError}`,
      attempts,
      ...(lastModel ? { model: lastModel } : {}),
      failures,
      ...(wrongCheckoutDiagnostic ? { wrongCheckoutDiagnostic } : {}),
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
    scopeEvidence: string[] = [],
    allowLegacyNoCodeEvidence = false,
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
    const noChangesNeeded = parseResult.data?.noChangesNeeded ?? false

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

    // DEV informou ::NO_CHANGES:: — tarefa não exigiu alterações de código
    if (!hasChanges && noChangesNeeded) {
      return { success: true, response, attempts: 1, hasChanges: false, noChangesNeeded: true, buildPassed: true, ...(context.model ? { model: context.model } : {}) }
    }
    if (!hasChanges && !allowNoChanges) {
      const wrongCheckoutDiagnostic = await inspectMainRepository(context, { header: '', context: null, scopeEvidence })
      if (allowLegacyNoCodeEvidence && !wrongCheckoutDiagnostic && await isMainRepositoryClean(context) && hasValidationEvidence(response)) {
        return {
          success: true, response, attempts: 1, hasChanges: false, noChangesNeeded: true, legacyNoCodeChange: true,
          buildPassed: true, ...(context.model ? { model: context.model } : {}),
        }
      }
      return {
        success: false,
        error: wrongCheckoutDiagnostic?.summary ?? 'A sessão recuperada declarou conclusão, mas não alterou o worktree autorizado',
        attempts: 1,
        hasChanges: false,
        ...(wrongCheckoutDiagnostic ? { wrongCheckoutDiagnostic } : {}),
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

  private async routeExhaustedFailure(
    context: PrimitiveContext,
    errorMessage: string,
    attempts: number,
    maxAttempts: number,
    wrongCheckoutDiagnostic?: WrongCheckoutDiagnostic,
  ): Promise<void> {
    const handler = this.config.governedFailureHandler
    if (!handler) return
    try {
      await handler.handleFailure('worker_exhausted', {
        taskId: context.taskId,
        subtaskId: context.subtaskId ?? null,
        executionId: context.executionId,
        generation: context.generation,
        repoPath: context.repoPath,
        model: context.model,
        metadata: {
          attempts,
          maxAttempts,
          phase: attempts > 1 ? 'rework' : 'worker',
          wrongCheckout: wrongCheckoutDiagnostic,
        },
      }, {
        code: wrongCheckoutDiagnostic?.kind === 'main_repo_related_changes' ? 'INVALID_DELIVERY_WRONG_CHECKOUT' : 'WORKER_EXHAUSTED',
        message: errorMessage,
        actionResult: JSON.stringify({ attempts, maxAttempts, wrongCheckout: wrongCheckoutDiagnostic }),
      })
    } catch (error) {
      // O roteamento governado é best-effort; o resultado de falha do worker
      // continua sendo devolvido ao consumidor para preservar a paridade.
      context.logger?.warn('Falha ao rotear esgotamento do worker pelo catálogo', {
        error: error instanceof Error ? error.message : String(error),
      })
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

const DIAGNOSTIC_LIMIT = 4_000

/**
 * Inspeção deliberadamente somente leitura. Falhas de git não mascaram a
 * falha original de entrega: apenas deixam de acrescentar evidência.
 */
async function inspectMainRepository(context: PrimitiveContext, prompt: DevelopmentPrompt): Promise<WrongCheckoutDiagnostic | undefined> {
  if (!context.repoPath || context.repoPath === context.worktreePath) return undefined
  try {
    const [{ stdout: status }, { stdout: diff }] = await Promise.all([
      execFileAsync('git', ['status', '--porcelain'], { cwd: context.repoPath, maxBuffer: DIAGNOSTIC_LIMIT }),
      execFileAsync('git', ['diff', '--stat'], { cwd: context.repoPath, maxBuffer: DIAGNOSTIC_LIMIT }),
    ])
    const files = status.split('\n').map(line => line.slice(3).trim().replace(/^.* -> /, '')).filter(Boolean).slice(0, 40)
    if (files.length === 0) return undefined
    const citedPaths = extractCitedPaths([prompt.header, prompt.context ?? '', ...(prompt.scopeEvidence ?? [])].join('\n'))
    const related = files.filter(file => citedPaths.some(path => file === path || file.endsWith(`/${path}`) || path.endsWith(`/${file}`)))
    const listed = (related.length > 0 ? related : files).join(', ')
    const kind = related.length > 0 ? 'main_repo_related_changes' : 'main_repo_unrelated_changes'
    return {
      kind,
      files,
      diffSummary: diff.slice(0, DIAGNOSTIC_LIMIT),
      summary: related.length > 0
        ? `O programador declarou conclusão, mas não alterou o worktree autorizado. ALTERAÇÕES ENCONTRADAS NO REPOSITÓRIO PRINCIPAL: ${listed} — agente editou o caminho errado. Diff resumido: ${diff.slice(0, 1_500)}`
        : `O programador declarou conclusão, mas não alterou o worktree autorizado. O repositório principal possui alterações não relacionadas ao escopo identificado: ${listed}. Diff resumido: ${diff.slice(0, 1_500)}`,
    }
  } catch {
    return undefined
  }
}

async function isMainRepositoryClean(context: PrimitiveContext): Promise<boolean> {
  if (!context.repoPath || context.repoPath === context.worktreePath) return false
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: context.repoPath, maxBuffer: DIAGNOSTIC_LIMIT })
    return stdout.trim().length === 0
  } catch {
    return false
  }
}

function hasValidationEvidence(response: string): boolean {
  const hasCommand = /\b(?:npx|npm|pnpm|yarn|git|node|tsc|vitest|docker|curl|make|pytest|go test|cargo)\b/i.test(response)
    || /`(?:npx|npm|pnpm|yarn|git|node|tsc|vitest|docker|curl|make|pytest|go test|cargo)\b/i.test(response)
  const hasResult = /\b(?:pass(?:ou|ed)?|ok|sucesso|succeeded|resultado|exit\s*(?:code)?\s*0|sem erros?|falhou|failed)\b/i.test(response)
  return hasCommand && hasResult
}

function extractCitedPaths(text: string): string[] {
  return [...new Set((text.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+/g) ?? []).map(path => path.replace(/^\.\//, '')))]
}
