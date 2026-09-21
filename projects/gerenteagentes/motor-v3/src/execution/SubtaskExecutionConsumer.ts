import { randomUUID } from 'node:crypto'
import type { QueueMessage } from '../queue/QueueMessage.js'
import type { OperationLogEntry, OperationLogger } from '../commands/OperationLogger.js'
import type { PrimitiveContext } from '../primitives/types.js'
import type { DevelopmentPrompt, WorkerLauncher, WorkerResult } from '../worker-launcher/WorkerLauncher.js'
import type { MySqlDevelopmentExecutionRepository, SubtaskExecutionContext } from './DevelopmentExecutionRepository.js'
import type { GitWorktreePreparer } from './GitWorktreePreparer.js'
import type { TestGateService, TestRunPhase } from '../testing/index.js'

export const SUBTASK_EXECUTION_REQUESTED = 'SUBTASK_EXECUTION_REQUESTED'

export class SubtaskExecutionConsumer {
  constructor(
    private readonly repository: MySqlDevelopmentExecutionRepository,
    private readonly worktrees: GitWorktreePreparer,
    private readonly worker: Pick<WorkerLauncher, 'executeTask'>,
    private readonly consoleApi: unknown,
    private readonly db: unknown,
    private readonly operationLogger?: OperationLogger,
    private readonly testGate?: TestGateService,
  ) {}

  async handle(message: QueueMessage): Promise<void> {
    if (message.type !== SUBTASK_EXECUTION_REQUESTED) return
    const subtaskId = Number(message.payload.subtaskId)
    if (!Number.isInteger(subtaskId) || subtaskId <= 0) throw new Error('SUBTASK_EXECUTION_REQUESTED sem subtaskId válido')
    const operationId = randomUUID()
    await this.log(operationId, 1, message, { phase: 'received', outcome: 'executed', subtaskId })

    const execution = await this.repository.getExecutionContext(message.taskId, subtaskId)
    if (!execution) {
      await this.log(operationId, 2, message, { phase: 'rejected', outcome: 'skipped', subtaskId, reasonCode: 'subtask_not_running' })
      return
    }
    try {
      this.validateContext(execution)
    } catch (error) {
      await this.finishPreparationFailure(operationId, message, execution, error)
      return
    }

    let workspace: { path: string; branch: string; baseCommit: string; integrationPath: string; integrationBranch: string }
    try {
      workspace = await this.worktrees.prepare({
        taskId: execution.taskId,
        subtaskId,
        repoPath: execution.repoPath,
        baseBranch: execution.baseBranch,
      })
    } catch (error) {
      await this.finishPreparationFailure(operationId, message, execution, error)
      return
    }
    await this.repository.recordWorkspace(subtaskId, workspace.path, workspace.branch, workspace.baseCommit)
    await this.log(operationId, 2, message, {
      phase: 'primitive', outcome: 'succeeded', subtaskId, primitiveCode: 'prepare_worktree',
      result: { workspacePath: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit },
    })

    let baselineRunId: number | undefined
    if (this.testGate) {
      const baseline = await this.testGate.run({
        projectId: execution.projectId, taskDatabaseId: execution.databaseTaskId, subtaskId,
        phase: 'baseline', commitSha: workspace.baseCommit, baseCommitSha: workspace.baseCommit,
        branchName: workspace.integrationBranch, workspacePath: workspace.integrationPath,
        buildCommand: execution.buildCommand, testCommand: execution.testCommand,
      })
      baselineRunId = baseline.id
      await this.log(operationId, 3, message, {
        phase: 'primitive', outcome: baseline.status === 'passed' ? 'succeeded' : 'executed', subtaskId,
        primitiveCode: 'run_test_baseline', result: { testRunId: baseline.id, status: baseline.status, failureCount: baseline.failures.length },
      })
    }

    const context: PrimitiveContext = {
      taskId: execution.taskId,
      databaseTaskId: execution.databaseTaskId,
      projectId: execution.projectId,
      subtaskId,
      executionId: message.executionId,
      generation: 1,
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
      this.buildPrompt(execution, workspace.path),
      models,
      (model, error) => this.repository.recordModelFailure(model, error),
      this.testGate ? async (gateContext, phase) => this.runDifferentialGate(execution, gateContext, phase) : undefined,
    )
    const workerSequence = this.testGate ? 4 : 3
    await this.log(operationId, workerSequence, message, {
      phase: 'primitive', outcome: result.success ? 'succeeded' : 'failed', subtaskId,
      primitiveCode: 'start_programmer', result: this.resultForLog(result),
    })
    const next = await this.repository.finishExecution(execution, message, result)
    await this.log(operationId, workerSequence + 1, message, {
      phase: 'completed', outcome: result.success ? 'succeeded' : 'failed', subtaskId,
      result: { nextMessageId: next.messageId, nextMessageType: next.type, attempts: result.attempts },
    })
  }

  private async runDifferentialGate(
    execution: SubtaskExecutionContext,
    context: PrimitiveContext,
    phase: Exclude<TestRunPhase, 'baseline' | 'monitor_recovery' | 'pre_deploy'>,
  ) {
    if (!this.testGate || !context.baselineRunId) return { success: false, error: 'Baseline de testes ausente' }
    const run = await this.testGate.run({
      projectId: execution.projectId, taskDatabaseId: execution.databaseTaskId, subtaskId: execution.subtaskId,
      phase, baselineRunId: context.baselineRunId, commitSha: context.baseCommitSha ?? '',
      baseCommitSha: context.baseCommitSha, branchName: context.branchName, workspacePath: context.worktreePath,
      buildCommand: execution.buildCommand, testCommand: execution.testCommand,
    })
    const success = run.comparisonStatus === 'no_regression'
    const inconclusive = run.comparisonStatus === 'inconclusive'
    return {
      success, runId: run.id, newFailureCount: run.newFailures.length,
      preExistingFailureCount: run.preExistingFailures.length, resolvedFailureCount: run.resolvedFailures.length,
      retryableByDeveloper: !inconclusive,
      ...(success ? {} : inconclusive
        ? { error: 'Gate inconclusivo: o ambiente do pós-DEV diverge do ambiente registrado no baseline. A alteração não foi atribuída ao DEV.' }
        : { error: `Foram encontradas ${run.newFailures.length} regressões novas:\n${this.testGate.formatNewFailures(run)}` }),
    }
  }

  private validateContext(context: SubtaskExecutionContext): void {
    const missing = [
      ['projectSlug', context.projectSlug], ['repoPath', context.repoPath], ['baseBranch', context.baseBranch],
      ['agentId', context.agentId], ['buildCommand', context.buildCommand], ['testCommand', context.testCommand],
    ].filter(([, value]) => !value).map(([key]) => key)
    if (missing.length > 0) throw new Error(`Contexto de execução incompleto: ${missing.join(', ')}`)
  }

  private buildPrompt(context: SubtaskExecutionContext, workspacePath: string): DevelopmentPrompt {
    const description = context.taskDescription || 'N/A'
    const header = [
      'Execute somente a subtarefa abaixo no workspace autorizado.',
      `Tarefa: ${context.taskTitle}`,
      `Subtarefa ${context.seq}: ${context.title}`,
      `Escopo: ${context.scope}`,
      `Entregáveis: ${context.deliverables.join('; ') || 'conforme o escopo'}`,
      `Critérios de aceite: ${context.acceptanceCriteria.join('; ') || 'validar o resultado solicitado'}`,
      `Workspace autorizado: ${workspacePath}`,
      'Preserve mudanças existentes, não altere outros projetos e não faça push ou deploy.',
      'Ao terminar e validar, inclua o marcador ::DONE:: na resposta final.',
    ].join('\n')
    // O viewer/sessão do agente pode truncar uma missão longa. Mantemos o
    // mesmo limite do v2: até 12k no header; acima, contexto separado até 30k.
    if (description.length > 12_000) {
      return { header, context: `Descrição completa da missão:\n\n${description.substring(0, 30_000)}` }
    }
    return {
      header: `${header}\nDescrição da missão: ${description.substring(0, 12_000)}`,
      context: null,
    }
  }

  private resultForLog(result: WorkerResult): Record<string, unknown> {
    return {
      success: result.success, attempts: result.attempts, model: result.model, failures: result.failures,
      hasChanges: result.hasChanges, buildPassed: result.buildPassed, error: result.error,
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
}
