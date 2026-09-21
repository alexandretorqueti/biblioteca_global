import { describe, expect, it, vi } from 'vitest'
import { SubtaskExecutionConsumer } from '../src/execution/SubtaskExecutionConsumer.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

const message: QueueMessage = {
  messageId: 'execute-1', type: 'SUBTASK_EXECUTION_REQUESTED', taskId: 'task-p6-845',
  executionId: 'execution-1', payload: { subtaskId: 901, seq: 1 },
  timestamp: new Date().toISOString(), correlationId: 'corr-1', causationId: 'ready-1', attempt: 1,
}

const context = {
  taskId: 'task-p6-845', databaseTaskId: 845, subtaskId: 901, seq: 1,
  taskTitle: 'Ajuste simples', taskDescription: 'Trocar uma letra', title: 'Corrigir texto', scope: 'Tela principal',
  acceptanceCriteria: ['Texto corrigido'], deliverables: ['Componente alterado'],
  projectSlug: 'admin-global', repoPath: '/repo', baseBranch: 'base-desenvolvimento',
  buildCommand: 'npm run build', testCommand: 'npm test', agentId: 'admin-global',
  workspacePath: null, workspaceBranch: null, workspaceBaseCommit: null,
}

describe('SubtaskExecutionConsumer', () => {
  it('prepara o worktree, executa o programador e publica o resultado durável', async () => {
    const repository = {
      getExecutionContext: vi.fn().mockResolvedValue(context),
      getDevelopmentModelChain: vi.fn().mockResolvedValue(['modelo-a']),
      recordModelFailure: vi.fn().mockResolvedValue(undefined),
      recordWorkspace: vi.fn().mockResolvedValue(undefined),
      finishExecution: vi.fn().mockResolvedValue({ ...message, messageId: 'completed-1', type: 'SUBTASK_EXECUTION_COMPLETED' }),
    }
    const worktrees = { prepare: vi.fn().mockResolvedValue({ path: '/worktree', branch: 'motor-v3/task/901/a1', baseCommit: 'abc' }) }
    const worker = { executeTask: vi.fn().mockResolvedValue({ success: true, response: 'Feito ::DONE::', attempts: 1 }) }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskExecutionConsumer(repository as never, worktrees as never, worker as never, {}, {}, logger)

    await consumer.handle(message)

    expect(repository.recordWorkspace).toHaveBeenCalledWith(901, '/worktree', 'motor-v3/task/901/a1', 'abc')
    expect(worker.executeTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-p6-845', subtaskId: 901, worktreePath: '/worktree',
      buildCommand: 'npm run build', testCommand: 'npm test',
    }), expect.stringContaining('Workspace autorizado: /worktree'), ['modelo-a'], expect.any(Function))
    expect(repository.finishExecution).toHaveBeenCalledWith(context, message, expect.objectContaining({ success: true }))
    expect(logger.append).toHaveBeenCalledTimes(4)
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'completed', outcome: 'succeeded', result: expect.objectContaining({ nextMessageType: 'SUBTASK_EXECUTION_COMPLETED' }),
    }))
  })

  it('registra rejeição idempotente quando a subtarefa não está mais running', async () => {
    const repository = { getExecutionContext: vi.fn().mockResolvedValue(null), getDevelopmentModelChain: vi.fn() }
    const worktrees = { prepare: vi.fn() }
    const worker = { executeTask: vi.fn() }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskExecutionConsumer(repository as never, worktrees as never, worker as never, {}, {}, logger)

    await consumer.handle(message)

    expect(worktrees.prepare).not.toHaveBeenCalled()
    expect(worker.executeTask).not.toHaveBeenCalled()
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: 'subtask_not_running' }))
  })

  it('publica falha durável quando o programador esgota tentativas', async () => {
    const repository = {
      getExecutionContext: vi.fn().mockResolvedValue(context), recordWorkspace: vi.fn(),
      getDevelopmentModelChain: vi.fn().mockResolvedValue(['modelo-a']),
      recordModelFailure: vi.fn().mockResolvedValue(undefined),
      finishExecution: vi.fn().mockResolvedValue({ ...message, messageId: 'failed-1', type: 'SUBTASK_EXECUTION_FAILED' }),
    }
    const worktrees = { prepare: vi.fn().mockResolvedValue({ path: '/worktree', branch: 'branch', baseCommit: 'abc' }) }
    const worker = { executeTask: vi.fn().mockResolvedValue({ success: false, error: 'timeout', attempts: 3 }) }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskExecutionConsumer(repository as never, worktrees as never, worker as never, {}, {}, logger)

    await consumer.handle(message)

    expect(repository.finishExecution).toHaveBeenCalledWith(context, message, expect.objectContaining({ success: false, error: 'timeout' }))
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'completed', outcome: 'failed' }))
  })

  it('não deixa a subtarefa running quando a preparação do worktree falha', async () => {
    const repository = {
      getExecutionContext: vi.fn().mockResolvedValue(context),
      getDevelopmentModelChain: vi.fn(),
      finishExecution: vi.fn().mockResolvedValue({ ...message, messageId: 'failed-prepare', type: 'SUBTASK_EXECUTION_FAILED' }),
    }
    const worktrees = { prepare: vi.fn().mockRejectedValue(new Error('spawn git ENOENT')) }
    const worker = { executeTask: vi.fn() }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskExecutionConsumer(repository as never, worktrees as never, worker as never, {}, {}, logger)

    await consumer.handle(message)

    expect(worker.executeTask).not.toHaveBeenCalled()
    expect(repository.finishExecution).toHaveBeenCalledWith(context, message, expect.objectContaining({
      success: false, error: expect.stringContaining('spawn git ENOENT'),
    }))
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'completed', outcome: 'failed' }))
  })

  it('falha de forma durável quando não existe modelo DEV disponível', async () => {
    const repository = {
      getExecutionContext: vi.fn().mockResolvedValue(context), recordWorkspace: vi.fn(),
      getDevelopmentModelChain: vi.fn().mockResolvedValue([]),
      recordModelFailure: vi.fn(),
      finishExecution: vi.fn().mockResolvedValue({ ...message, messageId: 'failed-model', type: 'SUBTASK_EXECUTION_FAILED' }),
    }
    const worktrees = { prepare: vi.fn().mockResolvedValue({ path: '/worktree', branch: 'branch', baseCommit: 'abc' }) }
    const worker = { executeTask: vi.fn() }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskExecutionConsumer(repository as never, worktrees as never, worker as never, {}, {}, logger)

    await consumer.handle(message)

    expect(worker.executeTask).not.toHaveBeenCalled()
    expect(repository.finishExecution).toHaveBeenCalledWith(context, message, expect.objectContaining({
      success: false, attempts: 0, error: expect.stringContaining('Nenhum modelo DEV'),
    }))
    expect(logger.append).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'no_development_model' }))
  })
})
