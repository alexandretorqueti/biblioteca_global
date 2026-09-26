import { describe, expect, it } from 'vitest'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import type { CommandPolicyRepository } from '../src/commands/index.js'
import type { OperationLogEntry, OperationLogger } from '../src/commands/index.js'
import { createQueueMessage } from '../src/queue/index.js'

/**
 * Regressão do incidente de 2026-09-25: o skip "motor busy" do dispatch gravava
 * sequence 2 — o mesmo sequence da decisão do govern() — violando a unique
 * (operation_id, sequence) do motor_operation_log. O skip benigno virava erro,
 * o QueueConsumer entrava em retry infinito e as mensagens de dispatch
 * (tarefas 835/836/887) morriam na DLQ.
 */

/** Logger que reproduz a constraint unique (operation_id, sequence) do banco. */
function strictLogger(): { logger: OperationLogger; entries: OperationLogEntry[] } {
  const entries: OperationLogEntry[] = []
  const seen = new Set<string>()
  return {
    entries,
    logger: {
      async append(entry: OperationLogEntry): Promise<void> {
        const key = `${entry.operationId}:${entry.sequence}`
        if (seen.has(key)) {
          throw new Error(`Duplicate entry '${key}' for key 'motor_operation_log_sequence_unique'`)
        }
        seen.add(key)
        entries.push(entry)
      },
    },
  }
}

const policies: CommandPolicyRepository = {
  async findByMessageType() {
    return {
      command: { code: 'C11_DEPLOY_BATCH_DISPATCH_REQUESTED', active: true, version: 1 },
      policies: [{ code: 'P11_DISPATCH_IF_IDLE', priority: 1, conditions: [], actionCode: 'A31_DISPATCH_DEPLOY_BATCH', active: true, version: 1 }],
    }
  },
}

function makeConsumer(logger: OperationLogger, claimBatch: () => Promise<null>) {
  const repository = { claimBatch } as never
  return new DeployConsumer(repository, {} as never, {} as never, logger, policies)
}

describe('DeployConsumer.dispatch — skip sem colisão de sequence', () => {
  it('skip por motor ocupado conclui sem erro e sem sequence duplicado', async () => {
    const { logger, entries } = strictLogger()
    const consumer = makeConsumer(logger, async () => null)
    const message = createQueueMessage({
      type: 'DEPLOY_BATCH_DISPATCH_REQUESTED',
      taskId: '887',
      executionId: 'deploy-dispatch-887-test',
      payload: { repository: '/repo', baseBranch: 'base-desenvolvimento', expectedCommit: 'abc1234' },
    })

    await expect(consumer.handle(message)).resolves.toBeUndefined()

    const sequences = entries.map(entry => entry.sequence)
    expect(sequences).toEqual([1, 2, 3])
    expect(entries[2]).toMatchObject({ phase: 'completed', outcome: 'skipped', reasonCode: 'motor_busy_or_no_compatible_pending_batch' })
  })

  it('todos os logs do dispatch compartilham o mesmo operationId', async () => {
    const { logger, entries } = strictLogger()
    const consumer = makeConsumer(logger, async () => null)
    const message = createQueueMessage({
      type: 'DEPLOY_BATCH_DISPATCH_REQUESTED',
      taskId: '835',
      executionId: 'deploy-dispatch-835-test',
      payload: { repository: '/repo', baseBranch: 'base-desenvolvimento', expectedCommit: 'abc1234' },
    })

    await consumer.handle(message)

    const operationIds = new Set(entries.map(entry => entry.operationId))
    expect(operationIds.size).toBe(1)
  })
})
