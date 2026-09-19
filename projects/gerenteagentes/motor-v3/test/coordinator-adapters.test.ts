import { describe, expect, it, vi } from 'vitest'
import { MySqlTaskCoordinatorRepository, WorkerAnalysisRunner } from '../src/coordinator/index.js'
import type { TaskSnapshot } from '../src/coordinator/index.js'

function task(): TaskSnapshot {
  return {
    taskId: 'task-1', title: 'Corrigir charset', description: 'Corrigir acentuação', agentId: 'agent-1',
    projectSlug: 'biblioteca', repoPath: '/repo', status: 'planned', paused: false,
    terminal: false, analysisStartedAt: null, subtaskCount: 0,
  }
}

describe('coordinator adapters', () => {
  it('faz claim e libera somente o executionId correspondente', async () => {
    const locked = {
      id: 42, external_id: 'task-1', status: 'planned', paused_at: null,
      analysis_started_at: null, analysis_execution_id: null, terminal_status: null,
      subtask_count: 0, blocked_count: 0,
    }
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      release: vi.fn(),
      query: vi.fn()
        .mockResolvedValueOnce([[locked], []])
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []]),
    }
    const pool = {
      getConnection: vi.fn(async () => connection),
      query: vi.fn(async () => [[], []]),
    } as any
    const repository = new MySqlTaskCoordinatorRepository(pool)

    await expect(repository.claimAnalysis('task-1', 'exec-1')).resolves.toBe(true)
    await repository.releaseAnalysisClaim('task-1', 'exec-1')

    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('f.analysis_execution_id = ?'), ['task-1', 'task-1', 'exec-1'])
  })

  it('não faz claim quando a tarefa já tem análise', async () => {
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      release: vi.fn(),
      query: vi.fn(async () => [[{
        id: 42, status: 'running', paused_at: null,
        analysis_started_at: new Date(), analysis_execution_id: 'other-exec',
        terminal_status: null, subtask_count: 0, blocked_count: 0,
      }], []]),
    }
    const pool = { getConnection: vi.fn(async () => connection) } as any
    const repository = new MySqlTaskCoordinatorRepository(pool)

    await expect(repository.claimAnalysis('task-1', 'exec-2')).resolves.toBe(false)
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
  })

  it('adapta o WorkerLauncher e propaga falha da análise', async () => {
    const consoleApi = {
      createSession: vi.fn(async () => ({ sessionId: 'session-1', sessionKey: 'motor-v3:analysis:task-1', agentId: 'agent-1' })),
      sendMessage: vi.fn(async () => {}),
      getSessionStatus: vi.fn()
        .mockResolvedValueOnce({ isComplete: false })
        .mockResolvedValueOnce({ isComplete: true, lastResponse: JSON.stringify({
          subtarefas: [{ seq: 1, titulo: 'Corrigir texto', scope: 'Ajustar texto', acceptance_criteria: ['OK'], deliverables: ['Código'], requirements_covered: ['REQ-1'], depends_on: [] }],
          requirements: [{ id: 'REQ-1', description: 'Texto correto' }], coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
        }) }),
    }
    const { ConsoleAnalystRunner } = await import('../src/analysis/index.js')
    const runner = new ConsoleAnalystRunner(consoleApi, { pollIntervalMs: 0 })

    const result = await runner.start(task(), 'exec-1')
    expect(result.kind).toBe('plan')
    expect(consoleApi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ sessionId: 'session-1' }) }))
  })
})
