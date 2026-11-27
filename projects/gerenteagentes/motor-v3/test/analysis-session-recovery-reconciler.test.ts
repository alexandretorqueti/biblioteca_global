// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { AnalysisSessionRecoveryReconciler, MySqlAnalysisFailureBlocker } from '../src/coordinator/index.js'
import type { TaskCoordinatorRepository, TaskSnapshot } from '../src/coordinator/TaskCoordinator.js'
import type { AnalystConsole, ConsoleAnalystRunner } from '../src/analysis/ConsoleAnalystRunner.js'
import type { MotorActivityGate } from '../src/queue/index.js'

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
        // Default para UPDATEs e otras queries
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
        // Default para UPDATEs e otras queries
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

  it('skipa ciclo reconciliador quando motor.pausado === false', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: String(sql), params })
        const sqlStr = String(sql)
        if (/LEFT JOIN motor_active_executions/i.test(sqlStr)) {
          return [[recoveryRow]]
        }
        if (/f\.analysis_started_at IS NULL OR f\.analysis_execution_id != s\.analysis_execution_id/i.test(sqlStr)) {
          return [[]]
        }
        return [{ affectedRows: 1 }]
      }),
    } as unknown as Pool
    const repository = {} as TaskCoordinatorRepository
    const runner = {} as ConsoleAnalystRunner
    const consoleApi = {} as AnalystConsole
    const events = { record: vi.fn(async () => undefined) }
    const motorActivityGate = { isActive: vi.fn(async () => false) } as unknown as MotorActivityGate
    const reconciler = new AnalysisSessionRecoveryReconciler(pool, repository, runner, consoleApi, {
      taskEvents: events,
      publishTaskReady: vi.fn(async () => undefined),
      motorActivityGate,
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(reconciler.reconcile()).resolves.toBeUndefined()

    // Não deve haver queries de recovery ou órfãs
    expect(queries).toHaveLength(0)
    expect(motorActivityGate.isActive).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith('[Motor v3] Reconciliador de sessões de análise: motor pausado, ciclo ignorado')
  })

  it('executa ciclo completo quando motor.ativo === true', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: String(sql), params })
        const sqlStr = String(sql)
        if (/LEFT JOIN motor_active_executions/i.test(sqlStr)) {
          return [[recoveryRow]]
        }
        if (/f\.analysis_started_at IS NULL OR f\.analysis_execution_id != s\.analysis_execution_id/i.test(sqlStr)) {
          return [[]]
        }
        return [{ affectedRows: 1 }]
      }),
    } as unknown as Pool
    const repository = {
      getTask: vi.fn(async () => task),
    } as unknown as TaskCoordinatorRepository
    const runner = { resume: vi.fn(async () => ({ kind: 'completion', response: 'ok' })) } as unknown as ConsoleAnalystRunner
    const consoleApi = { getSessionStatus: vi.fn(async () => ({ isComplete: false, isFailed: false })) } as unknown as AnalystConsole
    const events = { record: vi.fn(async () => undefined) }
    const publishTaskReady = vi.fn(async () => undefined)
    const motorActivityGate = { isActive: vi.fn(async () => true) } as unknown as MotorActivityGate
    const reconciler = new AnalysisSessionRecoveryReconciler(pool, repository, runner, consoleApi, {
      taskEvents: events,
      publishTaskReady,
      motorActivityGate,
    })

    await expect(reconciler.reconcile()).resolves.toBeUndefined()

    // Queries devem ser chamadas (recovery)
    expect(queries.some(q => q.sql.includes('SELECT') && q.sql.includes('analyst_task_sessions'))).toBe(true)
    expect(motorActivityGate.isActive).toHaveBeenCalledTimes(1)
    expect(repository.getTask).toHaveBeenCalledWith(task.taskId)
  })
  it('perguntas recuperadas mantêm a sessão em awaiting_clarification para retomada incremental', async () => {
    const questionsJson = JSON.stringify({ kind: 'perguntas', resumo: 'preciso confirmar', perguntas: ['Prefere A ou B?'] })
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql: String(sql), params })
        const sqlStr = String(sql)
        if (/LEFT JOIN motor_active_executions/i.test(sqlStr)) {
          return [[recoveryRow]]
        }
        if (/f\.analysis_started_at IS NULL OR f\.analysis_execution_id != s\.analysis_execution_id/i.test(sqlStr)) {
          return [[]]
        }
        return [{ affectedRows: 1 }]
      }),
    } as unknown as Pool
    const repository = {
      getTask: vi.fn(async () => task),
      persistAnalysis: vi.fn(async () => undefined),
      releaseAnalysisClaim: vi.fn(async () => undefined),
      claimAnalysis: vi.fn(),
      acquireAnalysisLease: vi.fn(async () => undefined),
      heartbeatAnalysisLease: vi.fn(async () => undefined),
      releaseAnalysisLease: vi.fn(async () => undefined),
    } as unknown as TaskCoordinatorRepository
    const runner = { resume: vi.fn() } as unknown as ConsoleAnalystRunner
    const consoleApi = { getSessionStatus: vi.fn(async () => ({ isComplete: true, lastResponse: questionsJson })) } as unknown as AnalystConsole
    const events = { record: vi.fn(async () => undefined) }
    const publishTaskReady = vi.fn(async () => undefined)
    const reconciler = new AnalysisSessionRecoveryReconciler(pool, repository, runner, consoleApi, {
      taskEvents: events,
      publishTaskReady,
    })

    await expect(reconciler.reconcile()).resolves.toBeUndefined()
    await vi.waitFor(() => expect(events.record).toHaveBeenCalledWith(task.taskId, 'analysis_recovered_clarification', 'motor', expect.objectContaining({ sessionId: 55, executionId: 'exec-recovery-868', questionCount: 1 })))

    // A análise recuperada é persistida e o claim liberado com fencing.
    expect(repository.persistAnalysis).toHaveBeenCalledWith(task.taskId, 'exec-recovery-868', expect.objectContaining({ kind: 'questions' }))
    expect(repository.releaseAnalysisClaim).toHaveBeenCalledWith(task.taskId, 'exec-recovery-868')
    // A sessão NÃO é concluída: fica aguardando a resposta do usuário para a
    // retomada incremental na mesma sessão (task-p2-1040).
    const awaiting = queries.find(query => query.sql.includes("status='awaiting_clarification'"))
    expect(awaiting?.params).toEqual([55])
    expect(queries.some(query => query.sql.includes("close_reason='analysis_recovered'"))).toBe(false)
    expect(runner.resume).not.toHaveBeenCalled()
    expect(publishTaskReady).not.toHaveBeenCalled()
  })

  // Incidente 1137 (2026-11-27): duas recuperações morreram no Console com
  // EmbeddedAttemptSessionTakeoverError em lane congestionada e, após 2x
  // analysis_recovery_failed, a tarefa ficou em limbo — nem analisada, nem
  // bloqueada. A falha terminal agora vira bloqueio persistente com contagem
  // de tentativas no excerpt + TASK_BLOCKED no outbox do monitor.
  describe('bloqueio explícito na falha terminal de recuperação (incidente 1137)', () => {
    /** Pool fake que atende o MySqlAnalysisFailureBlocker real. */
    function blockerPool(options: { eventCount?: number; failureRows?: number; insertAffectedRows?: number } = {}) {
      const queries: Array<{ sql: string; params: unknown[] }> = []
      const connection = {
        beginTransaction: vi.fn(async () => {}),
        commit: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
        release: vi.fn(),
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          const normalized = String(sql).replace(/\s+/g, ' ').trim()
          queries.push({ sql: normalized, params })
          if (/SELECT t\.id AS tarefa_id/.test(normalized)) {
            return [[{ tarefa_id: 868, event_count: options.eventCount ?? 2, failure_rows: options.failureRows ?? 0 }]]
          }
          if (/INSERT INTO bloqueios/.test(normalized)) {
            return [{ affectedRows: options.insertAffectedRows ?? 1 }]
          }
          if (/SELECT b\.id, b\.tarefa_id FROM bloqueios/.test(normalized)) {
            return [[{ id: 91, tarefa_id: 868 }]]
          }
          return [{ affectedRows: 1 }]
        }),
      }
      const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool
      return { pool, connection, queries }
    }

    function failingReconciler(blocker: unknown, events = { record: vi.fn(async () => undefined) }) {
      const recoveryPool = {
        query: vi.fn(async (sql: string) => {
          const sqlStr = String(sql)
          if (/LEFT JOIN motor_active_executions/i.test(sqlStr)) return [[recoveryRow]]
          if (/f\.analysis_started_at IS NULL OR f\.analysis_execution_id != s\.analysis_execution_id/i.test(sqlStr)) return [[]]
          return [{ affectedRows: 1 }]
        }),
      } as unknown as Pool
      const repository = {
        getTask: vi.fn(async () => task),
        releaseAnalysisClaim: vi.fn(async () => undefined),
        claimAnalysis: vi.fn(), persistAnalysis: vi.fn(),
        acquireAnalysisLease: vi.fn(async () => undefined),
        heartbeatAnalysisLease: vi.fn(async () => undefined),
        releaseAnalysisLease: vi.fn(async () => undefined),
      } as unknown as TaskCoordinatorRepository
      const runner = { resume: vi.fn(async () => { throw new Error('EmbeddedAttemptSessionTakeoverError: session file changed while embedded prompt lock was released') }) } as unknown as ConsoleAnalystRunner
      const consoleApi = { getSessionStatus: vi.fn(async () => ({ isComplete: false, isFailed: false })) } as unknown as AnalystConsole
      const reconciler = new AnalysisSessionRecoveryReconciler(recoveryPool, repository, runner, consoleApi, {
        taskEvents: events,
        publishTaskReady: vi.fn(async () => undefined),
        recoveryFailureBlocker: blocker as never,
      })
      return { reconciler, events }
    }

    it('falha terminal de recuperação cria bloqueio analysis_recovery_failed com contagem de tentativas e TASK_BLOCKED no monitor', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const blockerEnv = blockerPool({ eventCount: 2 })
        const blocker = new MySqlAnalysisFailureBlocker(blockerEnv.pool)
        const { reconciler, events } = failingReconciler(blocker)

        await expect(reconciler.reconcile()).resolves.toBeUndefined()
        await vi.waitFor(() => expect(events.record).toHaveBeenCalledWith(task.taskId, 'analysis_recovery_failed', 'motor', expect.any(Object)))

        const insert = blockerEnv.queries.find(q => q.sql.includes('INSERT INTO bloqueios'))
        expect(insert).toBeDefined()
        expect(insert!.sql).toContain("b.block_reason = 'analysis_recovery_failed'")
        expect(insert!.sql).toContain('NOT EXISTS')
        expect(insert!.params[0]).toBe('analysis_recovery_failed')
        expect(insert!.params[1]).toBe('TASK_RESUME_REQUESTED')
        const excerpt = JSON.parse(String(insert!.params[2]))
        expect(excerpt).toMatchObject({
          sessionId: 55,
          executionId: 'exec-recovery-868',
          closeReason: 'analysis_recovery_failed',
          recoveryAttempts: 2,
        })
        expect(excerpt.error).toContain('EmbeddedAttemptSessionTakeoverError')

        // TASK_BLOCKED no outbox motor.monitor na MESMA transação do INSERT.
        const blocked = blockerEnv.queries.find(q => q.sql.includes('INSERT INTO motor_outbox'))
        expect(blocked).toBeDefined()
        expect(blocked!.params[1]).toBe('TASK_BLOCKED')
        expect(blocked!.params[2]).toBe('motor.monitor')
        const blockedPayload = JSON.parse(String(blocked!.params[5]))
        expect(blockedPayload).toMatchObject({ blockReason: 'analysis_recovery_failed', blockCommand: 'TASK_RESUME_REQUESTED', blockId: 91, databaseTaskId: 868 })
        expect(blockerEnv.connection.commit).toHaveBeenCalledOnce()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('contagem de tentativas usa motor_agent_session_failures quando a trilha de eventos está vazia', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const blockerEnv = blockerPool({ eventCount: 0, failureRows: 3 })
        const blocker = new MySqlAnalysisFailureBlocker(blockerEnv.pool)
        const { reconciler } = failingReconciler(blocker)

        await expect(reconciler.reconcile()).resolves.toBeUndefined()
        await vi.waitFor(() => {
          expect(blockerEnv.queries.some(q => q.sql.includes('INSERT INTO bloqueios'))).toBe(true)
        })
        const excerpt = JSON.parse(String(blockerEnv.queries.find(q => q.sql.includes('INSERT INTO bloqueios'))!.params[2]))
        expect(excerpt.recoveryAttempts).toBe(3)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('redelivery (bloqueio já ativo) não duplica: INSERT idempotente não emite TASK_BLOCKED', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const blockerEnv = blockerPool({ insertAffectedRows: 0 })
        const blocker = new MySqlAnalysisFailureBlocker(blockerEnv.pool)
        const { reconciler } = failingReconciler(blocker)

        await expect(reconciler.reconcile()).resolves.toBeUndefined()
        await vi.waitFor(() => {
          expect(blockerEnv.queries.some(q => q.sql.includes('INSERT INTO bloqueios'))).toBe(true)
        })
        expect(blockerEnv.queries.some(q => q.sql.includes('INSERT INTO motor_outbox'))).toBe(false)
        expect(blockerEnv.connection.commit).toHaveBeenCalledOnce()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it("closeReason 'recovery_session_failed' (Console informou falha) também gera bloqueio", async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const blockerEnv = blockerPool({ eventCount: 1 })
        const blocker = new MySqlAnalysisFailureBlocker(blockerEnv.pool)
        const recoveryPool = {
          query: vi.fn(async (sql: string) => {
            const sqlStr = String(sql)
            if (/LEFT JOIN motor_active_executions/i.test(sqlStr)) return [[recoveryRow]]
            if (/f\.analysis_started_at IS NULL OR f\.analysis_execution_id != s\.analysis_execution_id/i.test(sqlStr)) return [[]]
            return [{ affectedRows: 1 }]
          }),
        } as unknown as Pool
        const repository = {
          getTask: vi.fn(async () => task),
          releaseAnalysisClaim: vi.fn(async () => undefined),
          claimAnalysis: vi.fn(), persistAnalysis: vi.fn(),
          acquireAnalysisLease: vi.fn(async () => undefined),
          heartbeatAnalysisLease: vi.fn(async () => undefined),
          releaseAnalysisLease: vi.fn(async () => undefined),
        } as unknown as TaskCoordinatorRepository
        const runner = { resume: vi.fn() } as unknown as ConsoleAnalystRunner
        const consoleApi = { getSessionStatus: vi.fn(async () => ({ isComplete: false, isFailed: true, error: 'EmbeddedAttemptSessionTakeoverError' })) } as unknown as AnalystConsole
        const events = { record: vi.fn(async () => undefined) }
        const reconciler = new AnalysisSessionRecoveryReconciler(recoveryPool, repository, runner, consoleApi, {
          taskEvents: events,
          publishTaskReady: vi.fn(async () => undefined),
          recoveryFailureBlocker: blocker as never,
        })

        await expect(reconciler.reconcile()).resolves.toBeUndefined()
        await vi.waitFor(() => {
          const insert = blockerEnv.queries.find(q => q.sql.includes('INSERT INTO bloqueios'))
          expect(insert).toBeDefined()
        })
        const excerpt = JSON.parse(String(blockerEnv.queries.find(q => q.sql.includes('INSERT INTO bloqueios'))!.params[2]))
        expect(excerpt.closeReason).toBe('recovery_session_failed')
        expect(excerpt.recoveryAttempts).toBe(1)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('falha ao criar o bloqueio não derruba o ciclo do reconciliador e o evento continua registrado', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const blocker = { blockForAnalysisRecoveryFailure: vi.fn(async () => { throw new Error('MySQL indisponível') }) }
        const { reconciler, events } = failingReconciler(blocker)

        await expect(reconciler.reconcile()).resolves.toBeUndefined()
        // O evento é gravado independentemente do bloqueio (ordem no failRecovery).
        await vi.waitFor(() => expect(events.record).toHaveBeenCalledWith(task.taskId, 'analysis_recovery_failed', 'motor', expect.any(Object)))
        await vi.waitFor(() => expect(blocker.blockForAnalysisRecoveryFailure).toHaveBeenCalledWith(task.taskId, expect.objectContaining({
          sessionId: 55,
          executionId: 'exec-recovery-868',
          closeReason: 'analysis_recovery_failed',
        })))
      } finally {
        errorSpy.mockRestore()
      }
    })
  })
})
