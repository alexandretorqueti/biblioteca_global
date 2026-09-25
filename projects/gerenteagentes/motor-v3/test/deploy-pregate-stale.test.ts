import { describe, expect, it, vi } from 'vitest'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import { DeployRepository } from '../src/deploy/DeployRepository.js'
import type { OperationLogger } from '../src/commands/index.js'
import { createQueueMessage } from '../src/queue/index.js'

/**
 * Regressão do incidente de 2026-09-25 (job 64, tarefa 886): job pre_deploy
 * órfão reenfileirado pela recuperação cujo deploy_request já estava terminal
 * ('succeeded'). Dois problemas cobertos aqui:
 *
 * 1. `continueAfterPreDeployGate` bloqueava a tarefa quando o gate falhava
 *    ANTES de verificar se ainda havia pedido pendente — job obsoleto com gate
 *    reprovado criaria bloqueio espúrio em tarefa já implantada.
 * 2. Nada reenfileirava os dispatches pendentes (835/836/887) depois que o
 *    gate concluía e o motor voltava a ficar ocioso — o skip "motor ocupado"
 *    confirma a mensagem e dependia de próximo boot/TASK_EXECUTION_COMPLETED.
 */

function fakeConnection(results: unknown[][]) {
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(() => {}),
    query: vi.fn(async () => [results.shift() ?? [], []]),
  }
  const pool = { getConnection: vi.fn(async () => connection) }
  return { pool: pool as never, connection }
}

function noopLogger(): OperationLogger {
  return { append: async () => {} }
}

describe('DeployRepository.continueAfterPreDeployGate — job obsoleto não bloqueia tarefa', () => {
  it('gate reprovado SEM pedido pendente → not_pending, sem bloqueio', async () => {
    const { pool, connection } = fakeConnection([
      [{ status: 'failed', failures: 3, commit_sha: '06f7d04' }], // test_runs
      [], // deploy_requests pendentes: nenhum
    ])
    const repository = new DeployRepository(pool, '/tmp/worktrees')
    const blockTask = vi.spyOn(repository, 'blockTask').mockResolvedValue(undefined)
    const message = createQueueMessage({ type: 'TEST_RUN_COMPLETED', taskId: 'task-p1-886', executionId: 'gate-recovery-64', payload: { phase: 'pre_deploy', testRunId: 80, jobId: 64, status: 'failed' } })

    const result = await repository.continueAfterPreDeployGate('task-p1-886', 80, message)

    expect(result).toEqual({ accepted: false, reason: 'deploy_request_not_pending' })
    expect(blockTask).not.toHaveBeenCalled()
    expect(connection.commit).toHaveBeenCalled()
  })

  it('gate reprovado COM pedido pendente → bloqueia a tarefa (comportamento preservado)', async () => {
    const { pool } = fakeConnection([
      [{ status: 'failed', failures: 3, commit_sha: '06f7d04' }],
      [{ repo_path: '/repo', base_branch: 'base-desenvolvimento', requested_commit: '06f7d04' }],
    ])
    const repository = new DeployRepository(pool, '/tmp/worktrees')
    const blockTask = vi.spyOn(repository, 'blockTask').mockResolvedValue(undefined)
    const message = createQueueMessage({ type: 'TEST_RUN_COMPLETED', taskId: 'task-p1-886', executionId: 'gate-886', payload: { phase: 'pre_deploy', testRunId: 80, jobId: 64, status: 'failed' } })

    const result = await repository.continueAfterPreDeployGate('task-p1-886', 80, message)

    expect(result).toEqual({ accepted: false, reason: 'pre_deploy_gate_failed' })
    expect(blockTask).toHaveBeenCalledTimes(1)
  })

  it('gate aprovado COM pedido pendente → enfileira o dispatch (comportamento preservado)', async () => {
    const { pool, connection } = fakeConnection([
      [{ status: 'passed', failures: 0, commit_sha: '06f7d04' }],
      [{ repo_path: '/repo', base_branch: 'base-desenvolvimento', requested_commit: '06f7d04' }],
      [{ affectedRows: 1 }], // insertOutboxMessage
    ])
    const repository = new DeployRepository(pool, '/tmp/worktrees')
    const message = createQueueMessage({ type: 'TEST_RUN_COMPLETED', taskId: 'task-p1-886', executionId: 'gate-886', payload: { phase: 'pre_deploy', testRunId: 80, jobId: 64, status: 'passed' } })

    const result = await repository.continueAfterPreDeployGate('task-p1-886', 80, message)

    expect(result).toEqual({ accepted: true })
    expect(connection.commit).toHaveBeenCalled()
  })
})

describe('DeployConsumer.afterGate — re-enfileira dispatches pendentes ao concluir gate', () => {
  it('gate obsoleto (not_pending) ainda re-enfileira dispatches pendentes', async () => {
    const enqueuePendingDispatches = vi.fn(async () => 3)
    const repository = {
      continueAfterPreDeployGate: vi.fn(async () => ({ accepted: false, reason: 'deploy_request_not_pending' })),
      enqueuePendingDispatches,
      findPendingBatchByGateJob: vi.fn(async () => null),
    } as never
    const consumer = new DeployConsumer(repository, {} as never, {} as never, noopLogger())
    const message = createQueueMessage({ type: 'TEST_RUN_COMPLETED', taskId: 'task-p1-886', executionId: 'gate-recovery-64', payload: { phase: 'pre_deploy', testRunId: 80, jobId: 64, status: 'passed' } })

    await expect(consumer.handle(message)).resolves.toBeUndefined()
    expect(enqueuePendingDispatches).toHaveBeenCalledTimes(1)
  })

  it('fases diferentes de pre_deploy não disparam re-enqueue', async () => {
    const enqueuePendingDispatches = vi.fn(async () => 0)
    const repository = { continueAfterPreDeployGate: vi.fn(), enqueuePendingDispatches } as never
    const consumer = new DeployConsumer(repository, {} as never, {} as never, noopLogger())
    const message = createQueueMessage({ type: 'TEST_RUN_COMPLETED', taskId: 't', executionId: 'e', payload: { phase: 'post_dev', testRunId: 1 } })

    await consumer.handle(message)
    expect(enqueuePendingDispatches).not.toHaveBeenCalled()
  })
})
