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
        const sqlStr = String(sql)
        // Query de recovery normal (com LEFT JOIN motor_active_executions)
        if (/LEFT JOIN motor_active_executions/i.test(sqlStr)) {
          return [[recoveryRow]]
        }
        // Query de sessões órfãs (sem resultados para este teste)
        if (/f\.analysis_started_at IS NULL OR f\.analysis_execution_id != s\.analysis_execution_id/i.test(sqlStr)) {
          return [[]]
        }
        // Default para UPDATEs e outras queries
        return [{ affectedRows: 1 }]
      }),
    } as unknown as Pool
    const repository = {
      getTask: vi.fn(async () => task),
      releaseAnalysisClaim: vi.fn(async () => undefined),
      claimAnalysis: vi.fn(), persistAnalysis: vi.fn(),
    } as unknown as TaskCoordinatorRepository
    const lease = {
      acquireAnalysisLease: vi.fn(async () => undefined),
      heartbeatAnalysisLease: vi.fn(async () => undefined),
      releaseAnalysisLease: vi.fn(async () => undefined),
    }
    Object.assign(repository, lease)
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
    expect(lease.acquireAnalysisLease).toHaveBeenCalledWith(task.taskId, 'exec-recovery-868', 90_000)
    expect(lease.releaseAnalysisLease).toHaveBeenCalledWith('exec-recovery-868')
    expect(events.record).toHaveBeenCalledWith(task.taskId, 'analysis_recovery_failed', 'motor', expect.objectContaining({
      sessionId: 55, executionId: 'exec-recovery-868', error: expect.stringContaining('status failed'),
    }))
    // Busca especificamente o UPDATE de failRecovery (com close_reason como parâmetro)
    const close = queries.find(query => /UPDATE analyst_task_sessions/.test(query.sql) && query.params.length === 2 && query.params[0] === 'analysis_recovery_failed')
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

  it('limpa sessão órfã sem claim e dispara reanálise', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const orphanRow = {
      session_id: 195,
      tarefa_id: 873,
      task_external_id: 'task-p1-873',
      analysis_execution_id: 'exec-orphan-873',
    }
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: String(sql), params })
        const sqlStr = String(sql)
        // Query de recovery normal (com LEFT JOIN motor_active_executions)
        if (/LEFT JOIN motor_active_executions/i.test(sqlStr)) {
          return [[]] // Sem sessões com claim válido
        }
        // Query de sessões órfãs (com analysis_started_at IS NULL)
        if (/f\.analysis_started_at IS NULL OR f\.analysis_execution_id != s\.analysis_execution_id/i.test(sqlStr)) {
          return [[orphanRow]]
        }
        // Default para UPDATEs e outras queries
        return [{ affectedRows: 1 }]
      }),
    } as unknown as Pool

    const taskSnapshot: TaskSnapshot = {
      taskId: 'task-p1-873',
      title: 'Tarefa órfã',
      description: 'Descrição',
      taskType: 'desenvolvimento',
      agentId: 'sistema-adm-global',
      projectSlug: 'sistema-adm-global',
      repoPath: '/tmp/repo',
      status: 'analyzing',
      paused: false,
      terminal: false,
      analysisStartedAt: null,
      analysisExecutionId: null,
      subtaskCount: 0,
    }

    const repository = {
      getTask: vi.fn(async () => taskSnapshot),
      releaseAnalysisClaim: vi.fn(async () => undefined),
      claimAnalysis: vi.fn(),
      persistAnalysis: vi.fn(),
    } as unknown as TaskCoordinatorRepository

    const runner = {} as ConsoleAnalystRunner
    const consoleApi = {} as AnalystConsole
    const events = { record: vi.fn(async () => undefined) }
    const publishTaskResume = vi.fn(async () => undefined)

    const reconciler = new AnalysisSessionRecoveryReconciler(pool, repository, runner, consoleApi, {
      taskEvents: events,
      publishTaskReady: vi.fn(async () => undefined),
      publishTaskResume,
    })

    await expect(reconciler.reconcile()).resolves.toBeUndefined()

    // Aguarda processamento assíncrono
    await vi.waitFor(() => {
      expect(events.record).toHaveBeenCalledWith('task-p1-873', 'analysis_session_orphaned', 'motor', expect.objectContaining({
        sessionId: 195,
        tarefaId: 873,
        executionId: 'exec-orphan-873',
        closeReason: 'orphaned_by_restart',
      }))
    })

    // Verifica que a sessão foi marcada como failed
    const closeQuery = queries.find(q => /UPDATE analyst_task_sessions/.test(q.sql) && q.params.length === 1 && q.params[0] === 195)
    expect(closeQuery).toBeDefined()
    expect(closeQuery?.sql).toContain('orphaned_by_restart')

    // Verifica que TASK_RESUME_REQUESTED foi disparado
    expect(publishTaskResume).toHaveBeenCalledWith('task-p1-873', 'exec-orphan-873')

    // Verifica que o evento de resume foi registrado
    expect(events.record).toHaveBeenCalledWith('task-p1-873', 'analysis_orphan_resume_requested', 'motor', expect.objectContaining({
      sessionId: 195,
      executionId: 'exec-orphan-873',
    }))
  })

  it('não dispara reanálise quando tarefa tem subtarefas', async () => {
    const orphanRow = {
      session_id: 196,
      tarefa_id: 874,
      task_external_id: 'task-p1-874',
      analysis_execution_id: 'exec-orphan-874',
    }
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const sqlStr = String(sql)
        if (/LEFT JOIN motor_active_executions/i.test(sqlStr)) {
          return [[]]
        }
        if (/f\.analysis_started_at IS NULL OR f\.analysis_execution_id != s\.analysis_execution_id/i.test(sqlStr)) {
          return [[orphanRow]]
        }
        return [{ affectedRows: 1 }]
      }),
    } as unknown as Pool

    const taskWithSubtasks: TaskSnapshot = {
      taskId: 'task-p1-874',
      title: 'Tarefa com subtarefas',
      description: 'Descrição',
      taskType: 'desenvolvimento',
      agentId: 'sistema-adm-global',
      projectSlug: 'sistema-adm-global',
      repoPath: '/tmp/repo',
      status: 'running',
      paused: false,
      terminal: false,
      analysisStartedAt: '2026-09-23T18:00:00.000Z',
      analysisExecutionId: 'exec-874',
      subtaskCount: 3,
    }

    const repository = {
      getTask: vi.fn(async () => taskWithSubtasks),
      releaseAnalysisClaim: vi.fn(async () => undefined),
      claimAnalysis: vi.fn(),
      persistAnalysis: vi.fn(),
    } as unknown as TaskCoordinatorRepository

    const runner = {} as ConsoleAnalystRunner
    const consoleApi = {} as AnalystConsole
    const events = { record: vi.fn(async () => undefined) }
    const publishTaskResume = vi.fn(async () => undefined)

    const reconciler = new AnalysisSessionRecoveryReconciler(pool, repository, runner, consoleApi, {
      taskEvents: events,
      publishTaskReady: vi.fn(async () => undefined),
      publishTaskResume,
    })

    await expect(reconciler.reconcile()).resolves.toBeUndefined()

    // Sessão órfã foi marcada como failed
    await vi.waitFor(() => {
      expect(events.record).toHaveBeenCalledWith('task-p1-874', 'analysis_session_orphaned', 'motor', expect.any(Object))
    })

    // Mas TASK_RESUME_REQUESTED NÃO foi disparado porque tem subtarefas
    expect(publishTaskResume).not.toHaveBeenCalled()
  })
})
