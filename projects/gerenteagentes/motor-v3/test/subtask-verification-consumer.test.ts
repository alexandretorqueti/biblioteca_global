import { describe, expect, it, vi } from 'vitest'
import { SubtaskVerificationConsumer, SUBTASK_VERIFICATION_REQUESTED } from '../src/execution/SubtaskVerificationConsumer.js'
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

  it('propaga falha do gate de verificação para o retry/terminal da fila (MigrationJournalIntegrityError)', async () => {
    // O consumidor NUNCA engole o erro: é a propagação que faz o QueueConsumer
    // contar tentativas e, esgotado o maxAttempts, rotear a falha terminal ao
    // SubtaskTerminalFailureBlocker (bloqueio + 'verifying' → 'blocked').
    const message = { ...base, messageId: 'verify-err-1', type: SUBTASK_VERIFICATION_REQUESTED }
    const journalError = new Error('Migrations SQL adicionadas sem a tag correspondente no meta/_journal.json')
    journalError.name = 'MigrationJournalIntegrityError'
    const repository = {
      getExecutionContext: vi.fn().mockResolvedValue(context),
      assertDifferentialGate: vi.fn().mockRejectedValue(journalError),
    }
    const integrator = { verifyAndIntegrate: vi.fn() }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new SubtaskVerificationConsumer(repository as never, integrator as never, logger)

    await expect(consumer.handle(message)).rejects.toThrow(journalError)
    expect(repository.assertDifferentialGate).toHaveBeenCalledWith(context)
    expect(integrator.verifyAndIntegrate).not.toHaveBeenCalled()
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'failed', outcome: 'failed', reasonCode: 'verification_or_integration_failed',
      result: { error: journalError.message },
    }))
  })

  it('exporta o tipo roteável ao TerminalFailureRouter', () => {
    // start.ts usa esta constante no wiring do router de falha terminal.
    expect(SUBTASK_VERIFICATION_REQUESTED).toBe('SUBTASK_VERIFICATION_REQUESTED')
  })
})
// @vitest-environment node
