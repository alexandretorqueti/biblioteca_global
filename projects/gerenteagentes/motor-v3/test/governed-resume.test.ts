import { describe, expect, it, vi } from 'vitest'
import { MessageBus } from '../src/bus/MessageBus.js'
import { TaskCoordinator, type TaskCoordinatorRepository, type TaskSnapshot } from '../src/coordinator/index.js'
import type { CommandPolicyRepository, OperationLogEntry, OperationLogger } from '../src/commands/index.js'
import { createQueueMessage } from '../src/queue/index.js'

const task: TaskSnapshot = {
  taskId: '42', title: 'Retomar', description: 'Teste', taskType: 'desenvolvimento', agentId: 'agent', projectSlug: 'p', repoPath: '/tmp/p',
  status: 'planned', paused: false, terminal: false, analysisStartedAt: null, subtaskCount: 0,
}

describe('retomada governada', () => {
  it('consulta a política e persiste decisão, action e primitives', async () => {
    const entries: OperationLogEntry[] = []
    const logger: OperationLogger = { append: vi.fn(async entry => { entries.push(entry) }) }
    const policies: CommandPolicyRepository = {
      findByMessageType: vi.fn(async () => ({
        command: { code: 'C03_TASK_RESUME_REQUESTED', active: true, version: 1 },
        policies: [{ code: 'P03_RESUME_IF_ELIGIBLE', priority: 100, conditions: ['task_not_paused', 'task_not_terminal', 'task_not_blocked', 'task_has_no_subtasks', 'analysis_not_claimed'], actionCode: 'A21_RESUME_TASK_ANALYSIS', active: true, version: 1 }],
      })),
    }
    const repository: TaskCoordinatorRepository = {
      getTask: vi.fn(async () => task), claimAnalysis: vi.fn(async () => true), releaseAnalysisClaim: vi.fn(async () => {}), persistAnalysis: vi.fn(async () => {}),
    }
    const runner = { start: vi.fn(async () => ({ kind: 'questions' as const, summary: 'precisa confirmar', questions: ['ok?'] })) }
    const coordinator = new TaskCoordinator(repository, runner, new MessageBus(), { commandPolicies: policies, operationLogger: logger })

    await coordinator.handle(createQueueMessage({ type: 'TASK_RESUME_REQUESTED', taskId: '42', executionId: 'source', payload: {} }))

    expect(policies.findByMessageType).toHaveBeenCalledWith('TASK_RESUME_REQUESTED')
    expect(entries.map(entry => entry.phase)).toEqual(['received', 'decision', 'action', 'primitive', 'primitive', 'primitive', 'completed'])
    expect(entries.some(entry => entry.actionCode === 'A21_RESUME_TASK_ANALYSIS')).toBe(true)
    expect(entries.filter(entry => entry.phase === 'primitive').map(entry => entry.primitiveCode)).toEqual(['claim_analysis_atomic', 'emit_analysis_selected', 'start_analyst'])
  })
})
