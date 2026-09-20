import { describe, expect, it, vi } from 'vitest'
import { DevelopmentExecutionConsumer } from '../src/execution/DevelopmentExecutionConsumer.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

function readyMessage(): QueueMessage {
  return {
    messageId: 'ready-1',
    type: 'TASK_READY_FOR_PROGRAMMING',
    taskId: 'task-p6-845',
    executionId: 'analysis-1',
    payload: { subtaskCount: 1 },
    timestamp: new Date().toISOString(),
    correlationId: 'corr-1',
    attempt: 1,
  }
}

describe('DevelopmentExecutionConsumer', () => {
  it('reserva a subtarefa e registra a transição para execução', async () => {
    const repository = {
      reserveNextSubtask: vi.fn().mockResolvedValue({
        subtaskId: 901,
        seq: 1,
        message: {
          ...readyMessage(),
          messageId: 'execution-1',
          type: 'SUBTASK_EXECUTION_REQUESTED',
          executionId: 'exec-subtask-1',
          payload: { subtaskId: 901, seq: 1, title: 'Ajuste simples', scope: 'texto' },
        },
      }),
    }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new DevelopmentExecutionConsumer(repository as never, logger)

    await consumer.handle(readyMessage())

    expect(repository.reserveNextSubtask).toHaveBeenCalledWith('task-p6-845', expect.objectContaining({
      type: 'TASK_READY_FOR_PROGRAMMING',
    }))
    expect(logger.append).toHaveBeenCalledTimes(3)
    expect(logger.append).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'primitive',
      primitiveCode: 'claim_subtask_atomic',
      subtaskId: 901,
    }))
    expect(logger.append).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'completed',
      result: expect.objectContaining({ nextMessageType: 'SUBTASK_EXECUTION_REQUESTED' }),
    }))
  })

  it('não reclama quando não há subtarefa elegível', async () => {
    const repository = { reserveNextSubtask: vi.fn().mockResolvedValue(null) }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new DevelopmentExecutionConsumer(repository as never, logger)

    await consumer.handle(readyMessage())

    expect(logger.append).toHaveBeenCalledTimes(2)
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'rejected',
      outcome: 'skipped',
      reasonCode: 'no_eligible_subtask',
    }))
  })

  it('mantém a tarefa em fila quando o limite de desenvolvimento foi atingido', async () => {
    const repository = {
      reserveNextSubtask: vi.fn().mockResolvedValue({ kind: 'capacity_waiting', reason: 'project_limit' }),
    }
    const logger = { append: vi.fn().mockResolvedValue(undefined) }
    const consumer = new DevelopmentExecutionConsumer(repository as never, logger)

    await consumer.handle(readyMessage())

    expect(logger.append).toHaveBeenCalledTimes(2)
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'rejected', outcome: 'skipped', reasonCode: 'project_limit',
      result: { queue: 'motor_execution_wait_queue' },
    }))
  })

  it('ignora outras mensagens', async () => {
    const repository = { reserveNextSubtask: vi.fn() }
    const logger = { append: vi.fn() }
    const consumer = new DevelopmentExecutionConsumer(repository as never, logger)

    await consumer.handle({ ...readyMessage(), type: 'SUBTASK_EXECUTION_COMPLETED' })

    expect(repository.reserveNextSubtask).not.toHaveBeenCalled()
    expect(logger.append).not.toHaveBeenCalled()
  })
})
