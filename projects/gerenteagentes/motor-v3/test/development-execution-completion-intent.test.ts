// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MySqlDevelopmentExecutionRepository, type SubtaskExecutionContext } from '../src/execution/DevelopmentExecutionRepository.js'
import type { QueueMessage } from '../src/queue/QueueMessage.js'

const source: QueueMessage = {
  messageId: 'source-1', type: 'SUBTASK_EXECUTION_COMPLETED', taskId: 'task-963',
  executionId: 'exec-963', payload: {}, timestamp: new Date().toISOString(), attempt: 1,
}

const context: SubtaskExecutionContext = {
  taskId: 'task-963', databaseTaskId: 963, projectId: 1, subtaskId: 2, seq: 2,
  taskTitle: 'Tarefa mista', taskDescription: '', title: 'Análise final', scope: '',
  acceptanceCriteria: [], deliverables: [], projectSlug: 'gerenteagentes', repoPath: '',
  baseBranch: 'base-desenvolvimento', buildCommand: '', testCommand: '', agentId: 'agent',
  workspacePath: null, workspaceBranch: null, workspaceBaseCommit: null,
  completionKind: 'analysis', generation: 1,
}

function fakePool(hasIntegratedCode: boolean, dependents: Array<{ id: number; external_id: string | null }> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let subtaskIsFinal = false
  const connection = {
    beginTransaction: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined), release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params })
      if (/UPDATE subtarefas\s+SET status='verified'/.test(sql)) {
        if (subtaskIsFinal) return [{ affectedRows: 0 }]
        subtaskIsFinal = true
        return [{ affectedRows: 1 }]
      }
      if (/SELECT s\.id, s\.seq, s\.titulo, s\.scope/.test(sql)) return [[]]
      if (/SELECT COUNT\(\*\) total FROM subtarefas/.test(sql)) return [[{ total: 0 }]]
      if (/AS has_integrated_code/.test(sql)) return [[{ has_integrated_code: hasIntegratedCode ? 1 : 0 }]]
      if (/SELECT dependent\.id, dependent\.external_id/.test(sql)) return [dependents]
      if (/UPDATE deploy_requests dr/.test(sql)) return [{ affectedRows: 0 }]
      if (/SELECT COUNT\(\*\) AS total[\s\S]*FROM deploy_requests dr/.test(sql)) return [[{ total: 0 }]]
      if (/SELECT id FROM tarefas WHERE id=\? FOR UPDATE/.test(sql)) return [[]]
      if (/INSERT INTO deploy_requests/.test(sql)) return [{ affectedRows: 1 }]
      if (/FROM motor_execution_wait_queue/.test(sql)) return [[]]
      return [{ affectedRows: 1 }]
    }),
  }
  return { pool: { getConnection: vi.fn().mockResolvedValue(connection) } as never, calls, connection }
}

function outboxTypes(calls: Array<{ sql: string; params: unknown[] }>) {
  return calls.filter(call => /INSERT INTO motor_outbox/.test(call.sql)).map(call => ({
    type: String(call.params[1]), payload: JSON.parse(String(call.params[4])),
  }))
}

describe('conclusão analítica — intenção de deploy da tarefa inteira', () => {
  it('preserva o deploy quando uma subtarefa anterior integrou código', async () => {
    const fake = fakePool(true)
    await new MySqlDevelopmentExecutionRepository(fake.pool).completeNoCodeExecution(context, source, 'análise concluída')

    const messages = outboxTypes(fake.calls)
    const completed = messages.find(message => message.type === 'TASK_EXECUTION_COMPLETED')
    expect(completed?.payload).toMatchObject({ integratedCode: true })
    expect(completed?.payload.noCodeChange).toBeUndefined()
    expect(messages.map(message => message.type)).toContain('DEPLOY_REQUESTED')
    expect(fake.calls.some(call => /INSERT INTO deploy_requests/.test(call.sql))).toBe(false)
    const cancellation = fake.calls.find(call => /UPDATE deploy_requests dr/.test(call.sql))
    expect(cancellation?.params[0]).toContain('Cancelamento administrativo de deploy')
    expect(cancellation?.params[0]).not.toContain('Adjudicação administrativa sem deploy')
  })

  it('mantém a adjudicação administrativa quando nenhuma subtarefa integrou código', async () => {
    const fake = fakePool(false)
    await new MySqlDevelopmentExecutionRepository(fake.pool).completeNoCodeExecution(context, source, 'análise concluída')

    const messages = outboxTypes(fake.calls)
    const completed = messages.find(message => message.type === 'TASK_EXECUTION_COMPLETED')
    expect(completed?.payload).toMatchObject({ noCodeChange: true })
    expect(messages.map(message => message.type)).not.toContain('DEPLOY_REQUESTED')
    const tombstone = fake.calls.find(call => /INSERT INTO deploy_requests/.test(call.sql))
    expect(tombstone?.params[0]).toContain('Adjudicação administrativa sem deploy')
  })

  it('não duplica o pedido de deploy quando a entrega analítica é reenviada', async () => {
    const fake = fakePool(true)
    const repository = new MySqlDevelopmentExecutionRepository(fake.pool)
    await repository.completeNoCodeExecution(context, source, 'análise concluída')
    const before = outboxTypes(fake.calls).filter(message => message.type === 'DEPLOY_REQUESTED')

    await expect(repository.completeNoCodeExecution(context, source, 'reentrega')).rejects.toThrow('não está em execução')

    const after = outboxTypes(fake.calls).filter(message => message.type === 'DEPLOY_REQUESTED')
    expect(after).toHaveLength(before.length)
    expect(after).toHaveLength(1)
  })
})

describe('conclusão — retomada de dependentes sem esperar deploy (tarefa 1121)', () => {
  it('conclusão COM código integrado enfileira TASK_RESUME_REQUESTED (dependency_completion) dos dependentes elegíveis', async () => {
    const fake = fakePool(true, [{ id: 964, external_id: 'task-964' }])
    await new MySqlDevelopmentExecutionRepository(fake.pool).completeNoCodeExecution(context, source, 'análise concluída')

    const messages = outboxTypes(fake.calls)
    expect(messages.map(message => message.type)).toContain('DEPLOY_REQUESTED')
    const resume = messages.find(message => message.type === 'TASK_RESUME_REQUESTED')
    expect(resume).toBeDefined()
    expect(resume?.payload).toMatchObject({ reason: 'dependency_completion', dependencyTaskId: '963' })
    // A consulta de dependentes roda na MESMA transação, antes do commit:
    // o select ocorre antes do último COMMIT e a conexão só é liberada no finally.
    const resumeSelectIndex = fake.calls.findIndex(call => /SELECT dependent\.id, dependent\.external_id/.test(call.sql))
    expect(resumeSelectIndex).toBeGreaterThanOrEqual(0)
    const completedIndex = fake.calls.findIndex(call => /INSERT INTO motor_outbox/.test(call.sql) && String(call.params[1]) === 'TASK_EXECUTION_COMPLETED')
    expect(completedIndex).toBeGreaterThanOrEqual(0)
    expect(resumeSelectIndex).toBeGreaterThan(completedIndex)
  })

  it('regra nova: dependência desenvolvimento não exige deploy succeeded na consulta de retomada', async () => {
    const fake = fakePool(true, [])
    await new MySqlDevelopmentExecutionRepository(fake.pool).completeNoCodeExecution(context, source, 'análise concluída')

    const resumeSelect = fake.calls.find(call => /SELECT dependent\.id, dependent\.external_id/.test(call.sql))
    expect(resumeSelect).toBeDefined()
    expect(resumeSelect?.sql).toContain("dependency.tipo NOT IN ('desenvolvimento', 'verificacao', 'automacao')")
    expect(resumeSelect?.sql).not.toContain("dependency.tipo = 'desenvolvimento' AND NOT EXISTS")
    expect(resumeSelect?.sql).not.toContain("dependency_deploy.status = 'succeeded'")
    // Idempotência preservada: exclusão por outbox com reason dependency_completion
    // e por análise/subtarefas em andamento.
    expect(resumeSelect?.sql).toContain("'dependency_completion'")
    expect(resumeSelect?.sql).toContain('analysis_started_at IS NOT NULL')
    expect(resumeSelect?.sql).toContain("(SELECT COUNT(*) FROM subtarefas s WHERE s.tarefa_id = dependent.id) = 0")
  })

  it('conclusão SEM código integrado continua enfileirando dependentes elegíveis', async () => {
    const fake = fakePool(false, [{ id: 965, external_id: 'task-965' }])
    await new MySqlDevelopmentExecutionRepository(fake.pool).completeNoCodeExecution(context, source, 'análise concluída')

    const messages = outboxTypes(fake.calls)
    const resume = messages.find(message => message.type === 'TASK_RESUME_REQUESTED')
    expect(resume?.payload).toMatchObject({ reason: 'dependency_completion', dependencyTaskId: '963' })
    expect(messages.map(message => message.type)).not.toContain('DEPLOY_REQUESTED')
  })
})
