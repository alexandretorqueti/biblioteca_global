// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MySqlDevelopmentExecutionRepository, type SubtaskExecutionContext } from '../src/execution/DevelopmentExecutionRepository.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

const context: SubtaskExecutionContext = {
  taskId: 'task-p2-911', databaseTaskId: 911, projectId: 2, subtaskId: 1287, seq: 1,
  taskTitle: 'Corrigir fluxo', taskDescription: '', title: 'Implementar correção', scope: 'motor-v3',
  acceptanceCriteria: [], deliverables: [], projectSlug: 'gerenteagentes', repoPath: '/repo',
  baseBranch: 'base-desenvolvimento', buildCommand: 'npm run build', testCommand: 'npm test',
  agentId: 'gerenteagentes', workspacePath: null, workspaceBranch: null, workspaceBaseCommit: null,
  completionKind: 'code_change', generation: 1,
}

const source: QueueMessage = {
  messageId: 'execute-1287', type: 'SUBTASK_EXECUTION_REQUESTED', taskId: context.taskId,
  executionId: 'exec-1287', payload: { subtaskId: 1287 }, timestamp: new Date().toISOString(), attempt: 1,
}

function makePool(hasCorrective = false) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    queries.push({ sql: normalized, params })
    if (normalized.startsWith('UPDATE subtarefas SET status = ?')) return [{ affectedRows: 1 }]
    if (normalized.includes('correction_for_subtask_id')) return [hasCorrective ? [{ id: 1290 }] : []]
    if (normalized.startsWith('INSERT INTO bloqueios')) return [{ affectedRows: 1 }]
    if (normalized.startsWith('SELECT id FROM bloqueios')) return [[{ id: 77 }]]
    if (normalized.startsWith('INSERT INTO motor_outbox')) return [{ affectedRows: 1 }]
    if (normalized.includes('FROM motor_execution_wait_queue')) return [[]]
    return [[]]
  })
  const connection = { beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), query }
  return { pool: { getConnection: vi.fn().mockResolvedValue(connection) }, queries, connection }
}

describe('falha definitiva do WorkerLauncher', () => {
  it('materializa bloqueio e TASK_BLOCKED em motor.monitor quando não há corretiva', async () => {
    const fake = makePool()
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool as never)

    await repository.finishExecution(context, source, {
      success: false, attempts: 3,
      error: 'Esgotado número máximo de tentativas (3): O programador declarou conclusão, mas não alterou o worktree autorizado',
    })

    const blocker = fake.queries.find(entry => entry.sql.startsWith('INSERT INTO bloqueios'))
    expect(blocker?.params).toEqual(expect.arrayContaining([911, 1287, expect.stringContaining('"attempts":3')]))
    const monitorOutbox = fake.queries.find(entry =>
      entry.sql.startsWith('INSERT INTO motor_outbox') && entry.params.includes('motor.monitor'),
    )
    expect(monitorOutbox?.params).toEqual(expect.arrayContaining([
      'TASK_BLOCKED', context.taskId, expect.stringContaining('worker-exhausted-block'),
    ]))
    expect(fake.connection.commit).toHaveBeenCalledOnce()
  })

  it('preserva a corretiva já criada e não duplica bloqueio nem TASK_BLOCKED', async () => {
    const fake = makePool(true)
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool as never)

    await repository.finishExecution(context, source, {
      success: false, attempts: 3, error: 'Esgotado número máximo de tentativas (3): falha',
    })

    expect(fake.queries.some(entry => entry.sql.startsWith('INSERT INTO bloqueios'))).toBe(false)
    expect(fake.queries.some(entry => entry.params.includes('motor.monitor'))).toBe(false)
  })
})
