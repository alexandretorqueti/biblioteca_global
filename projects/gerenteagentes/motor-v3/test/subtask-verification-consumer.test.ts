import { describe, expect, it, vi } from 'vitest'
import { SubtaskVerificationConsumer } from '../src/execution/SubtaskVerificationConsumer.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

const base: QueueMessage = {
  messageId: 'completed-1', type: 'SUBTASK_EXECUTION_COMPLETED', taskId: 'task-p6-845',
  executionId: 'exec-1', payload: { subtaskId: 901, seq: 1 }, timestamp: new Date().toISOString(), attempt: 1,
}
const context = { taskId: 'task-p6-845', subtaskId: 901, seq: 1 }

describe('SubtaskVerificationConsumer', () => {
  it('transforma conclusão do programador em solicitação durável de verificação', async () => {
    const repository = {
      getExecutionContext: vi.fn().mockResolvedValue(context),
      requestVerification: vi.fn().mockResolvedValue({ ...base, messageId: 'verify-1', type: 'SUBTASK_VERIFICATION_REQUESTED' }),
    }
    const integrator = { verifyAndIntegrate: vi.fn() }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskVerificationConsumer(repository as never, integrator as never, logger)

    await consumer.handle(base)

    expect(repository.getExecutionContext).toHaveBeenCalledWith('task-p6-845', 901, 'delivered')
    expect(repository.requestVerification).toHaveBeenCalledWith(context, base)
    expect(integrator.verifyAndIntegrate).not.toHaveBeenCalled()
  })

  it('verifica, integra e persiste o próximo comando', async () => {
    const message = { ...base, messageId: 'verify-1', type: 'SUBTASK_VERIFICATION_REQUESTED' }
    const repository = {
      getExecutionContext: vi.fn().mockResolvedValue(context),
      assertDifferentialGate: vi.fn().mockResolvedValue(undefined),
      completeVerification: vi.fn().mockResolvedValue({
        verified: { ...message, messageId: 'verified-1', type: 'SUBTASK_VERIFIED' },
        next: { ...message, messageId: 'next-1', type: 'TASK_EXECUTION_COMPLETED' },
      }),
    }
    const evidence = { commitSha: 'abc', integrationCommitSha: 'def' }
    const integrator = { verifyAndIntegrate: vi.fn().mockResolvedValue(evidence) }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskVerificationConsumer(repository as never, integrator as never, logger)

    await consumer.handle(message)

    expect(repository.getExecutionContext).toHaveBeenCalledWith('task-p6-845', 901, 'verifying')
    expect(repository.completeVerification).toHaveBeenCalledWith(context, message, evidence)
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'completed', result: expect.objectContaining({ nextMessageType: 'TASK_EXECUTION_COMPLETED' }),
    }))
  })
})
