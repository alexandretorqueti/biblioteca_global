// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MySqlTaskCoordinatorRepository } from '../src/coordinator/index.js'
import type { AnalysisOutcome } from '../src/analysis/AnalystReply.js'

const questionsOutcome: AnalysisOutcome = { kind: 'questions', summary: 'preciso confirmar', questions: ['Prefere A ou B?', 'Qual prazo?'] }
const planOutcome: AnalysisOutcome = {
  kind: 'plan',
  subtasks: [{ seq: 1, titulo: 'Implementar', scope: 'Escopo', acceptanceCriteria: ['OK'], deliverables: ['Código'], requirementsCovered: ['REQ-1'], dependsOn: [], completionKind: 'code_change' }],
  coverage: { requirements: [{ id: 'REQ-1', description: 'Requisito' }], coverage: [{ requirement: 'REQ-1', coveredBy: [1] }] },
}

const sessionRow = {
  id: 99, session_key: 'analysis-model-x-task-1', runtime_session_id: 'runtime-session-1',
  model: 'model-x', model_attempt: 2, analysis_attempt_id: 'attempt-1',
}

function connectionMock(overrides: Partial<Record<string, [unknown, unknown]>> = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: String(sql), params })
      const sqlText = String(sql)
      for (const [pattern, result] of Object.entries(overrides)) {
        if (sqlText.includes(pattern)) return result
      }
      if (/SELECT t\.id, t\.tipo/.test(sqlText)) return [[{ id: 42, tipo: 'desenvolvimento', external_id: 'task-1', projeto_id: 7 }], []]
      if (/INSERT INTO tarefa_chats/.test(sqlText)) return [{ insertId: 77 }, []]
      if (/FROM analyst_task_sessions/.test(sqlText)) return [[sessionRow], []]
      if (/SELECT COALESCE\(MAX\(round_number\)/.test(sqlText)) return [[{ next_round: 2 }], []]
      if (/INSERT INTO analysis_clarification_checkpoints/.test(sqlText)) return [{ insertId: 55 }, []]
      if (/SELECT id FROM subtarefas/.test(sqlText)) return [[], []]
      if (/INSERT INTO subtarefas/.test(sqlText)) return [{ insertId: 101 }, []]
      // Realtime boundary: identidade ausente → eventos realtime ignorados no teste.
      if (/SELECT id, external_id, projeto_id FROM tarefas/.test(sqlText)) return [[], []]
      return [{}, []]
    }),
  }
  return { connection, calls }
}

function repositoryWith(connection: unknown, poolQuery?: ReturnType<typeof vi.fn>) {
  const pool = {
    getConnection: vi.fn(async () => connection),
    query: poolQuery ?? vi.fn(async () => [[], []]),
  }
  return new MySqlTaskCoordinatorRepository(pool as any)
}

describe('MySqlTaskCoordinatorRepository — checkpoints de clarificação', () => {
  it('persistAnalysis(perguntas) supercede rodadas antigas e insere checkpoint vinculado à sessão e ao executionId', async () => {
    const { connection, calls } = connectionMock()
    const repository = repositoryWith(connection)

    await repository.persistAnalysis('task-1', 'exec-analyze-1', questionsOutcome)

    const supersede = calls.find(call => call.sql.includes('UPDATE analysis_clarification_checkpoints') && call.sql.includes("'superseded'"))
    expect(supersede?.params).toEqual([42])
    const sessionLookup = calls.find(call => call.sql.includes('FROM analyst_task_sessions'))
    expect(sessionLookup?.params).toEqual([42, 'exec-analyze-1'])
    const insert = calls.find(call => call.sql.includes('INSERT INTO analysis_clarification_checkpoints'))
    expect(insert).toBeDefined()
    expect(insert?.params).toEqual([
      42, 2, 'analysis-model-x-task-1', 'runtime-session-1', 'model-x', 2,
      'attempt-1', 'exec-analyze-1', 99,
      JSON.stringify(['Prefere A ou B?', 'Qual prazo?']), 'preciso confirmar', null,
    ])
    expect(connection.commit).toHaveBeenCalledOnce()
    // Auditoria de chat preservada (append-only).
    expect(calls.some(call => call.sql.includes('INSERT INTO tarefa_chats'))).toBe(true)
    expect(calls.some(call => call.sql.includes('clarification_pending_at = NOW()'))).toBe(true)
  })

  it('persistAnalysis(plano) supercede checkpoints pendentes', async () => {
    const { connection, calls } = connectionMock()
    const repository = repositoryWith(connection)

    await repository.persistAnalysis('task-1', 'exec-analyze-2', planOutcome)

    expect(calls.some(call => call.sql.includes('UPDATE analysis_clarification_checkpoints') && call.sql.includes("'superseded'") && call.params[0] === 42)).toBe(true)
    expect(calls.some(call => call.sql.includes('INSERT INTO analysis_clarification_checkpoints'))).toBe(false)
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('findPendingClarificationCheckpoint mapeia a rodada pendente mais recente', async () => {
    const poolQuery = vi.fn(async () => [[{
      id: 55, round_number: 2, session_key: 'analysis-model-x-task-1', runtime_session_id: 'runtime-session-1',
      model: 'model-x', model_attempt: 1, analysis_attempt_id: 'attempt-1',
      analysis_execution_id: 'exec-analyze-1', questions: '["Prefere A ou B?"]', summary: 'preciso confirmar',
      task_external_id: 'task-1',
    }], []])
    const repository = repositoryWith({}, poolQuery)

    const checkpoint = await repository.findPendingClarificationCheckpoint('task-1')

    expect(poolQuery.mock.calls[0][0]).toContain("status = 'awaiting_response'")
    expect(poolQuery.mock.calls[0][1]).toEqual(['task-1', 'task-1'])
    expect(checkpoint).toEqual({
      id: 55, taskId: 'task-1', roundNumber: 2, sessionKey: 'analysis-model-x-task-1',
      runtimeSessionId: 'runtime-session-1', model: 'model-x', modelAttempt: 1,
      analysisAttemptId: 'attempt-1', analysisExecutionId: 'exec-analyze-1',
      questions: ['Prefere A ou B?'], summary: 'preciso confirmar',
    })
  })

  it('findPendingClarificationCheckpoint retorna null sem rodada pendente', async () => {
    const repository = repositoryWith({}, vi.fn(async () => [[], []]))
    expect(await repository.findPendingClarificationCheckpoint('task-1')).toBeNull()
  })

  it('claimClarificationCheckpoint faz fencing transacional: awaiting/answered reivindicáveis, demais rejeitados', async () => {
    const { connection, calls } = connectionMock({ 'SELECT status FROM analysis_clarification_checkpoints': [[{ status: 'awaiting_response' }], []] })
    const repository = repositoryWith(connection)

    const claimed = await repository.claimClarificationCheckpoint(55, 'exec-resume-1', 42)

    expect(claimed).toBe(true)
    expect(calls.some(call => call.sql.includes('FOR UPDATE'))).toBe(true)
    const update = calls.find(call => call.sql.includes("SET status = 'answered'"))
    expect(update?.params).toEqual(['exec-resume-1', 42, 55])
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).not.toHaveBeenCalled()
  })

  it('claimClarificationCheckpoint rejeita checkpoint consumido/superado (rollback)', async () => {
    const { connection } = connectionMock({ 'SELECT status FROM analysis_clarification_checkpoints': [[{ status: 'consumed' }], []] })
    const repository = repositoryWith(connection)

    const claimed = await repository.claimClarificationCheckpoint(55, 'exec-resume-1', null)

    expect(claimed).toBe(false)
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
  })

  it('claimClarificationCheckpoint permite re-reivindicar rodada answered (retry/restart)', async () => {
    const { connection, calls } = connectionMock({ 'SELECT status FROM analysis_clarification_checkpoints': [[{ status: 'answered' }], []] })
    const repository = repositoryWith(connection)

    const claimed = await repository.claimClarificationCheckpoint(55, 'exec-resume-2', null)

    expect(claimed).toBe(true)
    const update = calls.find(call => call.sql.includes("SET status = 'answered'"))
    expect(update?.params).toEqual(['exec-resume-2', null, 55])
  })

  it('consumeClarificationCheckpoint exige o resume_execution_id reivindicado (fencing)', async () => {
    const poolQuery = vi.fn(async () => [{ affectedRows: 1 }, []])
    const repository = repositoryWith({}, poolQuery)

    await repository.consumeClarificationCheckpoint(55, 'exec-resume-1')

    expect(poolQuery.mock.calls[0][0]).toContain("status = 'consumed'")
    expect(poolQuery.mock.calls[0][0]).toContain('resume_execution_id = ?')
    expect(poolQuery.mock.calls[0][0]).toContain("status = 'answered'")
    expect(poolQuery.mock.calls[0][1]).toEqual([55, 'exec-resume-1'])
  })

  it('findClarificationAnswer usa a mensagem informada e cai na última mensagem do usuário', async () => {
    const poolQuery = vi.fn(async () => [[{ id: 42, texto: 'Prefiro A' }], []])
    const repository = repositoryWith({}, poolQuery)

    const answer = await repository.findClarificationAnswer('task-1', 42)

    expect(answer).toEqual({ chatMessageId: 42, texto: 'Prefiro A' })
    expect(poolQuery.mock.calls[0][0]).toContain("c.role = 'user'")
    expect(poolQuery.mock.calls[0][1]).toEqual(['task-1', 'task-1', 42])

    // Fallback: mensagem informada não encontrada → última user do chat.
    const fallbackQuery = vi.fn(async () => [[], []])
    const fallbackRepository = repositoryWith({}, fallbackQuery)
    expect(await fallbackRepository.findClarificationAnswer('task-1', 999)).toBeNull()
    expect(fallbackQuery).toHaveBeenCalledTimes(2)
    expect(fallbackQuery.mock.calls[1][0]).toContain('ORDER BY c.id DESC')
  })
})
