import { describe, expect, it, vi } from 'vitest'
import { DevelopmentSessionRecoveryReconciler } from '../src/execution/DevelopmentSessionRecoveryReconciler.js'

const row = {
  session_id: 7,
  tarefa_id: 905,
  task_external_id: 'task-p2-905',
  subtarefa_id: 1219,
  session_key: 'dev-gpt-terra-task-p2-905-s1219',
  runtime_session_id: 'runtime-7',
  agent_id: 'programador-senior',
  model: 'openai/gpt-terra',
  execution_id: 'exec-905',
  baseline_run_id: 88,
}

function setup(status: Record<string, unknown>) {
  const pool = { query: vi.fn().mockResolvedValue([[]]).mockResolvedValueOnce([[row]]) }
  const repository = { requeueInterruptedExecution: vi.fn().mockResolvedValue({ messageId: 'retry-1' }) }
  const consumer = { recoverCompletedSession: vi.fn().mockResolvedValue(undefined) }
  const consoleApi = { getSessionStatus: vi.fn().mockResolvedValue(status) }
  const adapter = { attachSession: vi.fn(), isLocallyOwned: vi.fn().mockReturnValue(false) }
  const events = { record: vi.fn().mockResolvedValue(undefined) }
  const reconciler = new DevelopmentSessionRecoveryReconciler(
    pool as never, repository as never, consumer as never, consoleApi as never, adapter as never, { taskEvents: events as never },
  )
  return { reconciler, pool, repository, consumer, consoleApi, adapter, events }
}

describe('DevelopmentSessionRecoveryReconciler', () => {
  it('mantém a mesma sessão quando o run ainda está ativo', async () => {
    const { reconciler, pool, consumer, repository, adapter } = setup({ isComplete: false })

    await reconciler.reconcile()

    expect(adapter.attachSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'runtime-7' }))
    expect(consumer.recoverCompletedSession).not.toHaveBeenCalled()
    expect(repository.requeueInterruptedExecution).not.toHaveBeenCalled()
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('last_activity_at=NOW()'), [7])
  })

  it('processa a resposta concluída e retorna ao fluxo normal', async () => {
    const { reconciler, pool, consumer, repository } = setup({ isComplete: true, lastResponse: 'Concluído ::DONE::' })

    await reconciler.reconcile()

    expect(consumer.recoverCompletedSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'runtime-7', sessionKey: row.session_key, baselineRunId: 88,
      response: 'Concluído ::DONE::',
    }))
    expect(repository.requeueInterruptedExecution).not.toHaveBeenCalled()
  })

  it('encerra o checkpoint e reenfileira quando a sessão falhou', async () => {
    const { reconciler, pool, repository, consumer } = setup({ isComplete: false, isFailed: true, error: 'SESSION_FAILED' })

    await reconciler.reconcile()

    expect(repository.requeueInterruptedExecution).toHaveBeenCalledWith(
      'task-p2-905', 1219, 'exec-905', expect.stringContaining('SESSION_FAILED'),
    )
    expect(consumer.recoverCompletedSession).not.toHaveBeenCalled()
  })

  it('reenfileira subtarefa running antiga que caiu antes de persistir sessão', async () => {
    const { reconciler, pool, repository } = setup({ isComplete: false })
    pool.query.mockReset()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ tarefa_id: 905, task_external_id: 'task-p2-905', subtarefa_id: 1219 }]])

    await reconciler.reconcile()

    expect(repository.requeueInterruptedExecution).toHaveBeenCalledWith(
      'task-p2-905', 1219, 'orphan-dev-1219', 'running_without_persisted_session',
    )
  })
})
