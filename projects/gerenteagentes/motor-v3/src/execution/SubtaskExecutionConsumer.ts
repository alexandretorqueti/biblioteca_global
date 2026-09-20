import { randomUUID } from 'node:crypto'
import type { QueueMessage } from '../queue/QueueMessage.js'
import type { OperationLogEntry, OperationLogger } from '../commands/OperationLogger.js'
import type { PrimitiveContext } from '../primitives/types.js'
import type { WorkerLauncher, WorkerResult } from '../worker-launcher/WorkerLauncher.js'
import type { MySqlDevelopmentExecutionRepository, SubtaskExecutionContext } from './DevelopmentExecutionRepository.js'
import type { GitWorktreePreparer } from './GitWorktreePreparer.js'

export const SUBTASK_EXECUTION_REQUESTED = 'SUBTASK_EXECUTION_REQUESTED'

export class SubtaskExecutionConsumer {
  constructor(
    private readonly repository: MySqlDevelopmentExecutionRepository,
    private readonly worktrees: GitWorktreePreparer,
    private readonly worker: Pick<WorkerLauncher, 'executeTask'>,
    private readonly consoleApi: unknown,
    private readonly db: unknown,
    private readonly operationLogger?: OperationLogger,
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
    this.validateContext(execution)

    const workspace = await this.worktrees.prepare({
      taskId: execution.taskId,
      subtaskId,
      repoPath: execution.repoPath,
      baseBranch: execution.baseBranch,
    })
    await this.repository.recordWorkspace(subtaskId, workspace.path, workspace.branch, workspace.baseCommit)
    await this.log(operationId, 2, message, {
      phase: 'primitive', outcome: 'succeeded', subtaskId, primitiveCode: 'prepare_worktree',
      result: { workspacePath: workspace.path, branch: workspace.branch, baseCommit: workspace.baseCommit },
    })

    const context: PrimitiveContext = {
      taskId: execution.taskId,
      subtaskId,
      executionId: message.executionId,
      generation: 1,
      projectSlug: execution.projectSlug,
      repoPath: execution.repoPath,
      worktreePath: workspace.path,
      branchName: workspace.branch,
      buildCommand: execution.buildCommand,
      testCommand: execution.testCommand,
      agentId: execution.agentId,
      db: this.db,
      consoleApi: this.consoleApi,
      logger: console,
    }
    const result = await this.worker.executeTask(context, this.buildPrompt(execution, workspace.path))
    await this.log(operationId, 3, message, {
      phase: 'primitive', outcome: result.success ? 'succeeded' : 'failed', subtaskId,
      primitiveCode: 'start_programmer', result: this.resultForLog(result),
    })
    const next = await this.repository.finishExecution(execution, message, result)
    await this.log(operationId, 4, message, {
      phase: 'completed', outcome: result.success ? 'succeeded' : 'failed', subtaskId,
      result: { nextMessageId: next.messageId, nextMessageType: next.type, attempts: result.attempts },
    })
  }

  private validateContext(context: SubtaskExecutionContext): void {
    const missing = [
      ['projectSlug', context.projectSlug], ['repoPath', context.repoPath], ['baseBranch', context.baseBranch],
      ['agentId', context.agentId], ['buildCommand', context.buildCommand], ['testCommand', context.testCommand],
    ].filter(([, value]) => !value).map(([key]) => key)
    if (missing.length > 0) throw new Error(`Contexto de execução incompleto: ${missing.join(', ')}`)
  }

  private buildPrompt(context: SubtaskExecutionContext, workspacePath: string): string {
    return [
      'Execute somente a subtarefa abaixo no workspace autorizado.',
      `Tarefa: ${context.taskTitle}`,
      `Descrição: ${context.taskDescription}`,
      `Subtarefa ${context.seq}: ${context.title}`,
      `Escopo: ${context.scope}`,
      `Entregáveis: ${context.deliverables.join('; ') || 'conforme o escopo'}`,
      `Critérios de aceite: ${context.acceptanceCriteria.join('; ') || 'validar o resultado solicitado'}`,
      `Workspace autorizado: ${workspacePath}`,
      'Preserve mudanças existentes, não altere outros projetos e não faça push ou deploy.',
      'Ao terminar e validar, inclua o marcador ::DONE:: na resposta final.',
    ].join('\n')
  }

  private resultForLog(result: WorkerResult): Record<string, unknown> {
    return { success: result.success, attempts: result.attempts, hasChanges: result.hasChanges, buildPassed: result.buildPassed, error: result.error }
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
