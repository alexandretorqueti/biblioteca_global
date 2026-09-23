import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { AnalysisSessionRecoveryReconciler } from '../src/coordinator/index.js'
import type { TaskCoordinatorRepository, TaskSnapshot } from '../src/coordinator/TaskCoordinator.js'
import type { AnalystConsole, ConsoleAnalystRunner } from '../src/analysis/ConsoleAnalystRunner.js'

const task: TaskSnapshot = {
  taskId: 'task-p6-868', title: 'Tarefa', description: 'Descrição', taskType: 'desenvolvimento',
  agentId: 'sistema-adm-global', projectSlug: 'sistema-adm-global', repoPath: '/tmp/repo',
  status: 'running', paused: false, terminal: false, analysisStartedAt: '2026-09-23T18:00:00.000Z',
  analysisExecutionId: 'exec-recovery-868', subtaskCount: 0,
}

const recoveryRow = {
  session_id: 55, tarefa_id: 868, task_external_id: task.taskId,
  session_key: 'agent:sistema-adm-global:analysis:868', runtime_session_id: 'console-55',
  model: 'qwen', execution_order: 1, analysis_execution_id: 'exec-recovery-868',
  analysis_attempt_id: 'attempt-1', model_attempt: 1, analysis_started_at: task.analysisStartedAt,
}

describe('AnalysisSessionRecoveryReconciler', () => {
  it('isola falha da retomada, fecha a sessão e libera somente o claim correspondente', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: String(sql), params })
        if (/^\s*SELECT/i.test(sql)) return [[recoveryRow]]
        return [{ affectedRows: 1 }]
      }),
    } as unknown as Pool
    const repository = {
      getTask: vi.fn(async () => task),
      releaseAnalysisClaim: vi.fn(async () => undefined),
      claimAnalysis: vi.fn(), persistAnalysis: vi.fn(),
    } as unknown as TaskCoordinatorRepository
    const runner = { resume: vi.fn(async () => { throw new Error('Sessão do Console terminou com status failed') }) } as unknown as ConsoleAnalystRunner
    const consoleApi = { getSessionStatus: vi.fn(async () => ({ isComplete: false, isFailed: false })) } as unknown as AnalystConsole
    const events = { record: vi.fn(async () => undefined) }
    const reconciler = new AnalysisSessionRecoveryReconciler(pool, repository, runner, consoleApi, {
      taskEvents: events,
      publishTaskReady: vi.fn(async () => undefined),
    })

    await expect(reconciler.reconcile()).resolves.toBeUndefined()
    await vi.waitFor(() => expect(events.record).toHaveBeenCalledWith(task.taskId, 'analysis_recovery_failed', 'motor', expect.any(Object)))

    expect(repository.releaseAnalysisClaim).toHaveBeenCalledWith(task.taskId, 'exec-recovery-868')
    expect(events.record).toHaveBeenCalledWith(task.taskId, 'analysis_recovery_failed', 'motor', expect.objectContaining({
      sessionId: 55, executionId: 'exec-recovery-868', error: expect.stringContaining('status failed'),
    }))
    const close = queries.find(query => /UPDATE analyst_task_sessions/.test(query.sql))
    expect(close?.params).toEqual(['analysis_recovery_failed', 55])
  })

  it('absorve falha da consulta do ciclo para manter o Motor vivo', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('MySQL indisponível') }) } as unknown as Pool
    const repository = {} as TaskCoordinatorRepository
    const runner = {} as ConsoleAnalystRunner
    const consoleApi = {} as AnalystConsole
    const reconciler = new AnalysisSessionRecoveryReconciler(pool, repository, runner, consoleApi, {
      publishTaskReady: vi.fn(async () => undefined),
    })

    await expect(reconciler.reconcile()).resolves.toBeUndefined()
  })
})
