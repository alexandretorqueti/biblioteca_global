import { describe, expect, it, vi } from 'vitest'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import type { OperationLogEntry, OperationLogger } from '../src/commands/index.js'
import { createQueueMessage } from '../src/queue/index.js'

/**
 * Limpeza automática de worktrees após deploy (tarefa 906): o resultado bem-sucedido
 * de um lote deve disparar GitWorktreePreparer.cleanup para cada tarefa do lote, sem
 * alterar o status já concluído do deploy. Deploys com falha preservam os worktrees
 * para debug. Falha na limpeza vira apenas warning (console), nunca falha do consumidor.
 */

function captureLogger() {
  const entries: OperationLogEntry[] = []
  const logger: OperationLogger = { async append(entry: OperationLogEntry): Promise<void> { entries.push(entry) } }
  return { logger, entries }
}

function makeMessage(status: 'success' | 'failed') {
  return createQueueMessage({ type: 'DEPLOY_BATCH_RESULT_RECEIVED', taskId: 'system', executionId: 'deploy-result-test', payload: { batchId: 'batch-1', status } })
}

describe('DeployConsumer.receiveResult — cleanup de worktrees pós-deploy', () => {
  it('deploy bem-sucedido chama cleanup para cada taskId retornado por completeBatch', async () => {
    const { logger } = captureLogger()
    const cleanup = vi.fn(async () => ({ removed: 1, branches: 1 }))
    const repoPathForTask = vi.fn(async () => '/repo')
    const repository = {
      completeBatch: vi.fn(async () => ['task-1', 'task-2']),
      repoPathForTask,
    } as never
    const consumer = new DeployConsumer(repository, {} as never, {} as never, logger, undefined, undefined, undefined, undefined, { cleanup } as never)

    await expect(consumer.handle(makeMessage('success'))).resolves.toBeUndefined()

    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledWith('task-1', '/repo')
    expect(cleanup).toHaveBeenCalledWith('task-2', '/repo')
    expect(repoPathForTask).toHaveBeenCalledTimes(2)
  })

  it('deploy com falha NÃO invoca cleanup (worktrees preservados para debug)', async () => {
    const { logger } = captureLogger()
    const cleanup = vi.fn(async () => ({ removed: 0, branches: 0 }))
    const repository = {
      completeBatch: vi.fn(async () => ['task-1']),
      repoPathForTask: vi.fn(async () => '/repo'),
    } as never
    const consumer = new DeployConsumer(repository, {} as never, {} as never, logger, undefined, undefined, undefined, undefined, { cleanup } as never)

    await expect(consumer.handle(makeMessage('failed'))).resolves.toBeUndefined()

    expect(cleanup).not.toHaveBeenCalled()
    expect(repository.repoPathForTask).not.toHaveBeenCalled()
  })

  it('falha na limpeza não altera o status concluído do deploy (apenas warning)', async () => {
    const { logger, entries } = captureLogger()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cleanup = vi.fn(async () => { throw new Error('git worktree remove falhou') })
    const repository = {
      completeBatch: vi.fn(async () => ['task-1']),
      repoPathForTask: vi.fn(async () => '/repo'),
    } as never
    const consumer = new DeployConsumer(repository, {} as never, {} as never, logger, undefined, undefined, undefined, undefined, { cleanup } as never)

    // O handle continua resolvendo: a falha de limpeza é engolida como warning.
    await expect(consumer.handle(makeMessage('success'))).resolves.toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Falha na limpeza de worktrees da tarefa task-1'), 'git worktree remove falhou')
    expect(entries.some(entry => entry.phase === 'completed' && entry.outcome === 'succeeded')).toBe(true)
    errorSpy.mockRestore()
  })
})
