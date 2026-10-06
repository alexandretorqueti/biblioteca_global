import { randomUUID } from 'node:crypto'
import type { QueueMessage } from '../queue/QueueMessage.js'
import type { OperationLogEntry, OperationLogger } from '../commands/OperationLogger.js'
import type { PrimitiveContext } from '../primitives/types.js'
import type { DevelopmentPrompt, WorkerLauncher, WorkerResult } from '../worker-launcher/WorkerLauncher.js'
import type { MySqlDevelopmentExecutionRepository, SubtaskExecutionContext } from './DevelopmentExecutionRepository.js'
import { GitWorktreePreparer, IntegrationBranchMissingError } from './GitWorktreePreparer.js'
import type { PreparedWorktree } from './GitWorktreePreparer.js'
import type {
  BaselinePreflightRecovery,
  TestGateOrchestrator,
  TestRunPhase,
  TestRunResult,
  WorkspaceEnvironmentPreparer,
} from '../testing/index.js'
import type { ManagedDevelopmentPromptResolver } from '../analysis/ManagedDevelopmentPromptResolver.js'
import type { GovernedFailureHandler } from '../governance/GovernedFailureHandler.js'

export const SUBTASK_EXECUTION_REQUESTED = 'SUBTASK_EXECUTION_REQUESTED'

export class SubtaskExecutionConsumer {
  private readonly deployLock?: { isDeployLocked(): Promise<boolean>; requeueForDeployRetry(message: QueueMessage, reason: string): Promise<void> }

  constructor(
    private readonly repository: MySqlDevelopmentExecutionRepository,
    private readonly worktrees: GitWorktreePreparer,
    private readonly worker: Pick<WorkerLauncher, 'executeTask' | 'recoverCompletedTask'>,
    private readonly consoleApi: { releaseLocalOwnership?: (sessionId: string | undefined) => void } | unknown,
    private readonly db: unknown,
    private readonly operationLogger?: OperationLogger,
    private readonly testGate?: TestGateOrchestrator,
    private readonly environmentPreparer?: WorkspaceEnvironmentPreparer,
    private readonly baselineRecovery?: BaselinePreflightRecovery,
    deployLock?: { isDeployLocked(): Promise<boolean>; requeueForDeployRetry(message: QueueMessage, reason: string): Promise<void> },
    private readonly promptResolver?: ManagedDevelopmentPromptResolver,
    private readonly governedFailureHandler?: GovernedFailureHandler,
  ) {
    this.deployLock = deployLock
  }

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== SUBTASK_EXECUTION_REQUESTED) return
    const receivedAt = Date.now()

    // Deploy atômico: verifica se o lock de deploy está ativo antes de processar.
    // Se locked, loga 'deploy_in_progress' e reenfileira com delay de 30s.
    if (this.deployLock) {
      const locked = await this.deployLock.isDeployLocked()
      if (locked) {
        const operationId = randomUUID()
        await this.log(operationId, 1, message, { phase: 'rejected', outcome: 'skipped', reasonCode: 'deploy_in_progress' })
        await this.deployLock.requeueForDeployRetry(message, 'deploy_in_progress')
        return
      }
    }

    const subtaskId = Number(message.payload.subtaskId)
    if (!Number.isInteger(subtaskId) || subtaskId <= 0) throw new Error('SUBTASK_EXECUTION_REQUESTED sem subtaskId válido')
    const operationId = randomUUID()
    await this.log(operationId, 1, message, { phase: 'received', outcome: 'executed', subtaskId })

    const execution = await this.repository.getExecutionContext(message.taskId, subtaskId)
    if (!execution) {
      await this.log(operationId, 2, message, { phase: 'rejected', outcome: 'skipped', subtaskId, reasonCode: 'subtask_not_running' })
      return
    }
    // Após restart, a mensagem original pode ser reentregue pelo RabbitMQ.
    // A sessão persistida pertence ao reconciliador; não crie outro worker.
    if (await this.repository.hasActiveDevelopmentSession?.(subtaskId)) {
      await this.log(operationId, 2, message, {
        phase: 'rejected', outcome: 'skipped', subtaskId, reasonCode: 'development_session_recovery_owned',
      })
      return
    }
    // Proteção contra recriação de sessão após DONE processado.
    // Se uma sessão foi concluída com sucesso nos últimos 10 minutos,
    // rejeita a mensagem em vez de criar nova sessão concorrente.
    if (await this.repository.hasRecentCompletedDevelopmentSession?.(subtaskId)) {
      await this.log(operationId, 2, message, {
        phase: 'rejected', outcome: 'skipped', subtaskId, reasonCode: 'development_session_already_completed',
      })
      return
    }
    try {
      this.validateContext(execution)
    } catch (error) {
      await this.finishPreparationFailure(operationId, message, execution, error)
      return
    }

    const noCode = ['analysis', 'no_code_change', 'external_operation'].includes(execution.completionKind ?? '')
    let baselineRunId: number | undefined
    let sequence = 2
    if (this.testGate && !noCode) {
      let integration
      try {
        integration = await this.worktrees.prepareIntegration({
          taskId: execution.taskId,
          repoPath: execution.repoPath,
          baseBranch: execution.baseBranch,
        })
        await this.log(operationId, sequence++, message, {
          phase: 'primitive', outcome: 'succeeded', subtaskId, primitiveCode: 'prepare_integration_worktree',
          result: { workspacePath: integration.integrationPath, branch: integration.integrationBranch, baseCommit: integration.baseCommit },
        })
        sequence = await this.logWorktreeRecoveries(operationId, sequence, message, subtaskId, integration.recoveries ?? [])
        if (this.environmentPreparer) {
          const packages = await this.environmentPreparer.prepare(integration.integrationPath)
          await this.log(operationId, sequence++, message, {
            phase: 'primitive', outcome: 'succeeded', subtaskId, primitiveCode: 'prepare_test_environment', result: { packages },
          })
        }
      } catch (error) {
        await this.finishPreparationFailure(operationId, message, execution, error)
        return
      }

      let baseline = await this.runBaseline(execution, subtaskId, integration, message)
      await this.log(operationId, sequence++, message, {
        phase: 'primitive', outcome: baseline.status === 'passed' ? 'succeeded' : 'executed', subtaskId,
        primitiveCode: 'run_test_baseline', result: { testRunId: baseline.id, status: baseline.status, failureCount: baseline.failures.length },
      })
      if (baseline.status !== 'passed' && this.isEnvironmentFailure(baseline) && this.environmentPreparer) {
        await this.environmentPreparer.prepare(integration.integrationPath)
        baseline = await this.runBaseline(execution, subtaskId, integration, message)
        await this.log(operationId, sequence++, message, {
          phase: 'primitive', outcome: baseline.status === 'passed' ? 'succeeded' : 'failed', subtaskId,
          primitiveCode: 'retry_environment_baseline', result: { testRunId: baseline.id, status: baseline.status, failureCount: baseline.failures.length },
        })
      }
      if (baseline.status !== 'passed') {
        if (this.isEnvironmentFailure(baseline)) {
          await this.routeBaselineFailure(execution, message, baseline,
            'O ambiente do baseline não pôde ser preparado automaticamente')
          await this.finishPreflightBlock(operationId, sequence, message, execution,
            `O ambiente do baseline não pôde ser preparado automaticamente: ${this.failureSummary(baseline)}`)
          return
        }
        if (!this.baselineRecovery) {
          await this.finishPreflightBlock(operationId, sequence, message, execution,
            `Baseline vermelho e recuperação pelo Monitor indisponível: ${this.failureSummary(baseline)}`)
          return
        }
        const recovered = await this.baselineRecovery.recover(execution, integration, baseline, message)
        await this.log(operationId, sequence++, message, {
          phase: 'primitive', outcome: recovered.success ? 'succeeded' : 'failed', subtaskId,
          primitiveCode: 'recover_baseline_before_development',
          result: { success: recovered.success, testRunId: recovered.baseline?.id, integrationCommit: recovered.integrationCommit, error: recovered.error },
        })
        if (!recovered.success || !recovered.baseline) {
          await this.routeBaselineFailure(execution, message, baseline,
            recovered.error ?? 'Monitor não deixou o baseline verde')
          await this.finishPreflightBlock(operationId, sequence, message, execution,
            recovered.error ?? 'Monitor não deixou o baseline verde')
          return
        }
        baseline = recovered.baseline
      }
      baselineRunId = baseline.id
    }

    let workspace: PreparedWorktree
    try {
      workspace = await this.worktrees.prepare({
        taskId: execution.taskId,
        subtaskId,
        repoPath: execution.repoPath,
        baseBranch: execution.baseBranch,
      })
      if (this.environmentPreparer && !noCode) await this.environmentPreparer.prepare(workspace.path)
    } catch (error) {
      // Se a branch de integração não existe (ambiente completamente perdido),
      // resetar subtarefas para pendente e tarefa para pronta
      if (error instanceof IntegrationBranchMissingError) {
        console.warn(`[Motor v3] Ambiente perdido para tarefa ${error.taskId}: branch ${error.branch} inexistente — resetando para pronta`)
        await this.repository.resetTaskToReady(execution.taskId)
        await this.log(operationId, sequence++, message, {
          phase: 'primitive', outcome: 'failed', subtaskId,
          primitiveCode: 'prepare_worktree',
          result: { error: error.message, action: 'reset_to_ready' },
        })
        return
      }
      await this.finishPreparationFailure(operationId, message, execution, error)
      return
    }
    await this.repository.recordWorkspace(subtaskId, workspace.path, workspace.branch, workspace.baseCommit)
    await this.log(operationId, sequence++, message, {
      phase: 'primitive', outcome: 'succeeded', subtaskId, primitiveCode: 'prepare_worktree',
      result: { workspacePath: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit },
    })
    sequence = await this.logWorktreeRecoveries(operationId, sequence, message, subtaskId, workspace.recoveries ?? [])

    const context: PrimitiveContext = {
      taskId: execution.taskId,
      databaseTaskId: execution.databaseTaskId,
      projectId: execution.projectId,
      subtaskId,
      executionId: message.executionId,
      generation: execution.generation ?? 1,
      projectSlug: execution.projectSlug,
      repoPath: execution.repoPath,
      worktreePath: workspace.path,
      branchName: workspace.branch,
      baseCommitSha: workspace.baseCommit,
      baselineRunId,
      buildCommand: execution.buildCommand,
      testCommand: execution.testCommand,
      agentId: execution.agentId,
      db: this.db,
      consoleApi: this.consoleApi,
      logger: console,
    }
    const models = await this.repository.getDevelopmentModelChain(execution.projectSlug)
    if (models.length === 0) {
      await this.finishExecutionFailure(
        operationId,
        message,
        execution,
        'Nenhum modelo DEV habilitado e disponível para o projeto (todos ausentes ou em cooldown)',
      )
      return
    }
    const result = await this.worker.executeTask(
      context,
      await this.buildPrompt(execution, workspace.path),
      models,
      (model, error) => this.repository.recordModelFailure(model, error),
      this.testGate && !noCode
        ? async (gateContext, phase) => {
          if (this.environmentPreparer) {
            await this.environmentPreparer.prepare(gateContext.worktreePath)
          }
          return this.runDifferentialGate(execution, gateContext, phase, message)
        } : undefined,
      noCode,
      receivedAt
        + Number(process.env.MOTOR_RABBITMQ_CONSUMER_TIMEOUT_MS || 5_400_000)
        - Number(process.env.MOTOR_RABBITMQ_ACK_SAFETY_MS || 300_000),
    )

    const workerSequence = sequence
    await this.log(operationId, workerSequence, message, {
      phase: 'primitive', outcome: result.success ? 'succeeded' : result.sessionHandedOff ? 'executed' : 'failed', subtaskId,
      primitiveCode: 'start_programmer', result: this.resultForLog(result),
    })
    if (result.sessionHandedOff) {
      const adapter = this.consoleApi as { releaseLocalOwnership?: (sessionId: string | undefined) => void }
      adapter.releaseLocalOwnership?.(context.sessionId)
      await this.log(operationId, workerSequence + 1, message, {
        phase: 'completed', outcome: 'executed', subtaskId, reasonCode: 'development_session_handed_off',
        result: { sessionId: context.sessionId, sessionKey: context.sessionKey, attempts: result.attempts },
      })
      return
    }
    const next = (result.success && noCode) || (result.success && result.noChangesNeeded)
      ? await this.repository.completeNoCodeExecution(execution, message, result.response ?? '')
      : await this.repository.finishExecution(execution, message, result)
    await this.repository.closeDevelopmentSession?.(subtaskId, context.sessionId, context.sessionKey, result.success)
    await this.log(operationId, workerSequence + 1, message, {
      phase: 'completed', outcome: result.success ? 'succeeded' : 'failed', subtaskId,
      result: { nextMessageId: next.messageId, nextMessageType: next.type, attempts: result.attempts },
    })
  }

  /** Retoma o pós-processamento de uma sessão DEV concluída durante o restart. */
  async recoverCompletedSession(input: {
    message: QueueMessage
    sessionId: string
    sessionKey: string
    model: string
    response: string
    baselineRunId?: number
  }): Promise<void> {
    const subtaskId = Number(input.message.payload.subtaskId)
    const execution = await this.repository.getExecutionContext(input.message.taskId, subtaskId)
    if (!execution) return
    this.validateContext(execution)
    if (!execution.workspacePath || !execution.workspaceBranch || !execution.workspaceBaseCommit) {
      throw new Error(`Subtarefa ${subtaskId} sem worktree persistido para recuperação`)
    }
    const context: PrimitiveContext = {
      taskId: execution.taskId,
      databaseTaskId: execution.databaseTaskId,
      projectId: execution.projectId,
      subtaskId,
      executionId: input.message.executionId,
      generation: execution.generation ?? 1,
      projectSlug: execution.projectSlug,
      repoPath: execution.repoPath,
      worktreePath: execution.workspacePath,
      branchName: execution.workspaceBranch,
      baseCommitSha: execution.workspaceBaseCommit,
      ...(input.baselineRunId ? { baselineRunId: input.baselineRunId } : {}),
      buildCommand: execution.buildCommand,
      testCommand: execution.testCommand,
      model: input.model,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      agentId: execution.agentId,
      db: this.db,
      consoleApi: this.consoleApi,
      logger: console,
    }
    const noCode = ['analysis', 'no_code_change', 'external_operation'].includes(execution.completionKind ?? '')
    const operationId = randomUUID()
    await this.log(operationId, 1, input.message, {
      phase: 'received', outcome: 'executed', subtaskId, reasonCode: 'development_session_recovered',
    })
    const result = await this.worker.recoverCompletedTask(
      context,
      input.response,
      this.testGate && !noCode ? async (gateContext, phase) => {
        if (this.environmentPreparer) {
          await this.environmentPreparer.prepare(gateContext.worktreePath)
        }
        return this.runDifferentialGate(execution, gateContext, phase, input.message)
      } : undefined,
      noCode,
      this.scopeEvidence(execution),
    )
    const next = (result.success && noCode) || (result.success && result.noChangesNeeded)
      ? await this.repository.completeNoCodeExecution(execution, input.message, input.response)
      : await this.repository.finishExecution(execution, input.message, result)
    await this.repository.closeDevelopmentSession?.(subtaskId, input.sessionId, input.sessionKey, result.success)
    await this.log(operationId, 2, input.message, {
      phase: 'completed', outcome: result.success ? 'succeeded' : 'failed', subtaskId,
      result: { recovered: true, nextMessageId: next.messageId, nextMessageType: next.type },
    })
  }

  private async runBaseline(
    execution: SubtaskExecutionContext,
    subtaskId: number,
    integration: { integrationPath: string; integrationBranch: string; baseCommit: string },
    source: QueueMessage,
  ): Promise<TestRunResult> {
    if (!this.testGate) throw new Error('Gate de testes indisponível')
    return this.testGate.request({
      projectId: execution.projectId, taskDatabaseId: execution.databaseTaskId, subtaskId,
      phase: 'baseline', commitSha: integration.baseCommit, baseCommitSha: integration.baseCommit,
      branchName: integration.integrationBranch, workspacePath: integration.integrationPath,
      buildCommand: execution.buildCommand, testCommand: execution.testCommand,
    }, source)
  }

  private isEnvironmentFailure(run: TestRunResult): boolean {
    return run.failures.length > 0 && run.failures.every(failure =>
      /cannot find (?:package|module)|failed to resolve import|command not found|enoent|npm error/i.test(
        `${failure.errorType} ${failure.normalizedMessage}`,
      ),
    )
  }

  private failureSummary(run: TestRunResult): string {
    return run.failures.length === 0
      ? 'o comando terminou com erro sem diagnóstico estruturado'
      : run.failures.map(failure => `${failure.suite}: ${failure.normalizedMessage}`).join('; ')
  }

  private async finishPreflightBlock(
    operationId: string,
    sequence: number,
    message: QueueMessage,
    execution: SubtaskExecutionContext,
    reason: string,
  ): Promise<void> {
    const next = await this.repository.blockExecution(execution, message, reason)
    await this.log(operationId, sequence, message, {
      phase: 'completed', outcome: 'failed', subtaskId: execution.subtaskId,
      reasonCode: 'baseline_preflight_failed',
      result: { nextMessageId: next.messageId, nextMessageType: next.type, attempts: 0, error: reason },
    })
  }

  private async routeBaselineFailure(
    execution: SubtaskExecutionContext,
    message: QueueMessage,
    baseline: TestRunResult,
    reason: string,
  ): Promise<void> {
    if (!this.governedFailureHandler) return
    try {
      await this.governedFailureHandler.handleFailure('baseline_red', {
        taskId: execution.taskId,
        subtaskId: execution.subtaskId,
        executionId: message.executionId,
        generation: 1,
        repoPath: execution.repoPath,
        agentId: execution.agentId,
        metadata: {
          phase: 'baseline',
          testRunId: baseline.id,
          failureCount: baseline.failures.length,
        },
      }, {
        code: 'BASELINE_RED',
        message: reason,
        actionResult: JSON.stringify({ testRunId: baseline.id, failureCount: baseline.failures.length }),
      })
    } catch (error) {
      console.warn('[SubtaskExecutionConsumer] falha ao rotear baseline vermelho pelo catálogo:', error instanceof Error ? error.message : String(error))
    }
  }

  private async runDifferentialGate(
    execution: SubtaskExecutionContext,
    context: PrimitiveContext,
    phase: Exclude<TestRunPhase, 'baseline' | 'monitor_recovery' | 'pre_deploy'>,
    source: QueueMessage,
  ) {
    if (!this.testGate || !context.baselineRunId) return { success: false, error: 'Baseline de testes ausente' }
    const run = await this.testGate.request({
      projectId: execution.projectId, taskDatabaseId: execution.databaseTaskId, subtaskId: execution.subtaskId,
      phase, baselineRunId: context.baselineRunId, commitSha: context.baseCommitSha ?? '',
      baseCommitSha: context.baseCommitSha, branchName: context.branchName, workspacePath: context.worktreePath,
      buildCommand: execution.buildCommand, testCommand: execution.testCommand,
    }, source)
    const success = run.comparisonStatus === 'no_regression'
    const inconclusive = run.comparisonStatus === 'inconclusive'
    if (!success) {
      await this.routeGateFailure(execution, source, context, run, phase)
    }
    return {
      success, runId: run.id, newFailureCount: run.newFailures.length,
      preExistingFailureCount: run.preExistingFailures.length, resolvedFailureCount: run.resolvedFailures.length,
      retryableByDeveloper: !inconclusive,
      ...(success ? {} : inconclusive
        ? { error: 'Gate inconclusivo: o ambiente do pós-DEV diverge do ambiente registrado no baseline. A alteração não foi atribuída ao DEV.' }
        : { error: [
            `Sua alteração introduziu ${run.newFailures.length} regressão(ões) nova(s):`,
            run.newFailures.map((failure, index) => `${index + 1}. ${failure.suite}${failure.testCase ? ` > ${failure.testCase}` : ''}: ${failure.normalizedMessage}`).join('\n'),
            '',
            `As ${run.preExistingFailures.length} falha(s) preexistente(s) permanecem fora do seu escopo e não devem ser corrigidas neste rework.`,
          ].join('\n') }),
    }
  }

  private async routeGateFailure(
    execution: SubtaskExecutionContext,
    source: QueueMessage,
    context: PrimitiveContext,
    run: TestRunResult,
    phase: Exclude<TestRunPhase, 'baseline' | 'monitor_recovery' | 'pre_deploy'>,
  ): Promise<void> {
    if (!this.governedFailureHandler) return
    try {
      await this.governedFailureHandler.handleFailure('gate_result', {
        taskId: execution.taskId,
        subtaskId: execution.subtaskId,
        executionId: source.executionId,
        generation: context.generation,
        repoPath: execution.repoPath,
        agentId: execution.agentId,
        metadata: {
          phase,
          testRunId: run.id,
          comparisonStatus: run.comparisonStatus,
          newFailureCount: run.newFailures.length,
        },
      }, {
        code: 'integration_gate_failed',
        message: run.comparisonStatus === 'inconclusive'
          ? 'Gate diferencial inconclusivo'
          : `Gate diferencial acusou ${run.newFailures.length} regressão(ões)`,
        actionResult: JSON.stringify({ testRunId: run.id, phase, comparisonStatus: run.comparisonStatus }),
      })
    } catch (error) {
      console.warn('[SubtaskExecutionConsumer] falha ao rotear resultado do gate pelo catálogo:', error instanceof Error ? error.message : String(error))
    }
  }

  private validateContext(context: SubtaskExecutionContext): void {
    const missing = [
      ['projectSlug', context.projectSlug], ['repoPath', context.repoPath], ['baseBranch', context.baseBranch],
      ['agentId', context.agentId], ['buildCommand', context.buildCommand], ['testCommand', context.testCommand],
    ].filter(([, value]) => !value).map(([key]) => key)
    if (missing.length > 0) throw new Error(`Contexto de execução incompleto: ${missing.join(', ')}`)
  }

  private async buildPrompt(context: SubtaskExecutionContext, workspacePath: string): Promise<DevelopmentPrompt> {
    const hardcoded = this.buildHardcodedPrompt(context, workspacePath)

    if (this.promptResolver) {
      try {
        const values: Record<string, string> = {
          '**TITULOTAREFA**': context.taskTitle,
          '**DESCRICAOTAREFA**': context.taskDescription || '',
          '**NUMSUBTAREFA**': String(context.seq),
          '**TITULOSUBTAREFA**': context.title,
          '**ESCOPO**': context.scope,
          '**CRITERIOSACEITE**': context.acceptanceCriteria.join('; ') || 'validar o resultado solicitado',
          '**WORKSPACE**': workspacePath,
        }
        const resolved = await this.promptResolver.resolve({
          key: 'dev.primeira_rodada_tarefa',
          values,
          fallback: hardcoded.header,
          taskId: context.taskId,
          subtaskId: context.subtaskId,
        })
        if (resolved.text) {
          return { header: resolved.text, context: hardcoded.context, scopeEvidence: this.scopeEvidence(context) }
        }
      } catch (error) {
        // Resolver failure — fall through to hardcoded prompt
      }
    }

    return hardcoded
  }

  private buildHardcodedPrompt(context: SubtaskExecutionContext, workspacePath: string): DevelopmentPrompt {
    const description = context.taskDescription || 'N/A'
    const generation = context.generation ?? 1
    const generationNote = generation > 1
      ? [
          `Esta é a generation ${generation} da tarefa. As generations anteriores já foram deployadas.`,
          'Faça apenas mudanças incrementais para o ajuste solicitado. Não refaça o que já foi feito.',
        ]
      : []
    const header = [
      'Execute somente a subtarefa abaixo no workspace autorizado.',
      `Tarefa: ${context.taskTitle}`,
      `Subtarefa ${context.seq}: ${context.title}`,
      `Escopo: ${context.scope}`,
      `Entregáveis: ${context.deliverables.join('; ') || 'conforme o escopo'}`,
      `Critérios de aceite: ${context.acceptanceCriteria.join('; ') || 'validar o resultado solicitado'}`,
      `Workspace autorizado: ${workspacePath}`,
      `Edite exclusivamente o workspace autorizado acima. É proibido editar o checkout principal em ${context.repoPath}.`,
      'Preserve mudanças existentes, não altere outros projetos e não faça push ou deploy.',
      ...generationNote,
      ...(['analysis', 'no_code_change', 'external_operation'].includes(context.completionKind ?? '')
        ? [
            'Esta subtarefa é analítica/sem alteração de código. Entregue o resultado solicitado sem modificar o Git.',
            'Quando a subtarefa não exigir alteração no código-fonte (ex: apenas executar testes, verificar configuração, confirmar comportamento), use ::DONE:: acompanhado de ::NO_CHANGES:: na resposta final.',
          ]
        : []),
      'Ao terminar e validar, inclua o marcador ::DONE:: na resposta final.',
    ].join('\n')
    if (description.length > 12_000) {
      return { header, context: `Descrição completa da missão:\n\n${description.substring(0, 30_000)}`, scopeEvidence: this.scopeEvidence(context) }
    }
    return {
      header: `${header}\nDescrição da missão: ${description.substring(0, 12_000)}`,
      context: null,
      scopeEvidence: this.scopeEvidence(context),
    }
  }

  private scopeEvidence(context: SubtaskExecutionContext): string[] {
    return [context.scope, context.taskDescription, ...context.acceptanceCriteria, ...context.deliverables]
  }

  private resultForLog(result: WorkerResult): Record<string, unknown> {
    return {
      success: result.success, attempts: result.attempts, model: result.model, failures: result.failures,
      sessionHandedOff: result.sessionHandedOff,
      hasChanges: result.hasChanges, buildPassed: result.buildPassed, error: result.error,
      wrongCheckoutDiagnostic: result.wrongCheckoutDiagnostic,
      baselineRunId: result.baselineRunId, postDevRunId: result.postDevRunId,
      preExistingFailureCount: result.preExistingFailureCount, resolvedFailureCount: result.resolvedFailureCount,
    }
  }

  private async finishExecutionFailure(
    operationId: string,
    message: QueueMessage,
    execution: SubtaskExecutionContext,
    reason: string,
  ): Promise<void> {
    const result: WorkerResult = { success: false, error: reason, attempts: 0, hasChanges: false, buildPassed: false }
    const sequence = this.testGate ? 4 : 3
    await this.log(operationId, sequence, message, {
      phase: 'primitive', outcome: 'failed', subtaskId: execution.subtaskId,
      primitiveCode: 'start_programmer', reasonCode: 'no_development_model', result: this.resultForLog(result),
    })
    const next = await this.repository.finishExecution(execution, message, result)
    await this.log(operationId, sequence + 1, message, {
      phase: 'completed', outcome: 'failed', subtaskId: execution.subtaskId,
      result: { nextMessageId: next.messageId, nextMessageType: next.type, attempts: 0 },
    })
  }


  private async finishPreparationFailure(
    operationId: string,
    message: QueueMessage,
    execution: SubtaskExecutionContext,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error)
    const result: WorkerResult = { success: false, error: `Falha de preparação: ${reason}`, attempts: 1, hasChanges: false, buildPassed: false }
    await this.log(operationId, 2, message, {
      phase: 'primitive', outcome: 'failed', subtaskId: execution.subtaskId,
      primitiveCode: 'prepare_worktree', result: this.resultForLog(result),
    })
    const next = await this.repository.finishExecution(execution, message, result)
    await this.log(operationId, 3, message, {
      phase: 'completed', outcome: 'failed', subtaskId: execution.subtaskId,
      result: { nextMessageId: next.messageId, nextMessageType: next.type, attempts: result.attempts },
    })
  }

  private async log(
    operationId: string,
    sequence: number,
    message: QueueMessage,
    data: Pick<OperationLogEntry, 'phase' | 'outcome'> & Partial<Pick<OperationLogEntry, 'subtaskId' | 'primitiveCode' | 'result' | 'reasonCode'>>,
  ): Promise<void> {
    await this.operationLogger?.append({
      operationId, sequence, messageId: message.messageId, messageType: message.type,
      correlationId: message.correlationId, causationId: message.causationId,
      taskId: message.taskId, ...data,
    })
  }

  private async logWorktreeRecoveries(
    operationId: string,
    sequence: number,
    message: QueueMessage,
    subtaskId: number,
    recoveries: Array<{ reasonCode: string; path: string; action: string; branch?: string; quarantinePath?: string }>,
  ): Promise<number> {
    for (const recovery of recoveries) {
      await this.log(operationId, sequence++, message, {
        phase: 'primitive', outcome: 'succeeded', subtaskId,
        primitiveCode: 'recover_worktree', reasonCode: recovery.reasonCode,
        result: recovery,
      })
    }
    return sequence
  }
}
