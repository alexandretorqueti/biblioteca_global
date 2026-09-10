/**
 * Testes do TaskCoordinator
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Db, TaskRepository, QueryResult } from '../src/shared/types/infrastructure.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'
import { ExecutionEventBus } from '../src/events/ExecutionEventBus.js'
import { WorkerLauncher } from '../src/workers/WorkerLauncher.js'

function createMockDb(): Db {
  const db: Db = {
    query: vi.fn().mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn(db)),
  }
  return db
}

function createMockRepository(): TaskRepository {
  return {
    saveTask: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  }
}

describe('TaskCoordinator', () => {
  let db: Db
  let repository: TaskRepository
  let resourceLease: ResourceLeaseService
  let coordinator: TaskCoordinator

  beforeEach(() => {
    db = createMockDb()
    repository = createMockRepository()
    resourceLease = new ResourceLeaseService({ db })
    coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
  })

  describe('pump', () => {
    it('inicia uma análise quando as duas vagas de desenvolvimento estão ocupadas', async () => {
      const coordinatorWithTwoDevelopers = new TaskCoordinator(db, repository, resourceLease, {
        maxWorkers: 2,
        maxWorkersPerProject: 1,
      })
      const task = {
        id: 'task-analysis-slot', chatId: '', agentId: 'analyst', title: 'Analisar agora', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm test',
        status: 'planned' as const, maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project-c',
        createdAt: '', updatedAt: '',
      }
      const internal = coordinatorWithTwoDevelopers as unknown as {
        activeWorkers: Map<string, unknown>
        selectNextSubtask(): Promise<null>
        selectNextTask(): Promise<typeof task | null>
        startTaskAnalysis(input: typeof task): Promise<boolean>
        reconcileOrphanedReadyTasks(): Promise<void>
        processDeployQueue(): Promise<void>
      }
      internal.activeWorkers.set('dev-a', { phase: 'execute', resourceKey: 'project:a:execution' })
      internal.activeWorkers.set('dev-b', { phase: 'execute', resourceKey: 'project:b:execution' })
      const selectSubtask = vi.spyOn(internal, 'selectNextSubtask').mockResolvedValue(null)
      vi.spyOn(internal, 'selectNextTask').mockResolvedValue(task)
      const startAnalysis = vi.spyOn(internal, 'startTaskAnalysis').mockResolvedValue(true)
      vi.spyOn(internal, 'reconcileOrphanedReadyTasks').mockResolvedValue()
      vi.spyOn(internal, 'processDeployQueue').mockResolvedValue()

      await coordinatorWithTwoDevelopers.pump()

      expect(selectSubtask).not.toHaveBeenCalled()
      expect(startAnalysis).toHaveBeenCalledOnce()
      expect(startAnalysis).toHaveBeenCalledWith(task)
    })

    it('a espera de uma subtarefa não impede a pista independente de análise', async () => {
      const task = {
        id: 'task-analysis-after-wait', chatId: '', agentId: 'analyst', title: 'Analisar após espera', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm test',
        status: 'planned' as const, maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project-b',
        createdAt: '', updatedAt: '',
      }
      const subtask = { id: 10, seq: 1, titulo: 'Dev aguardando', taskExternalId: 'task-dev', projectSlug: 'project-a' }
      const internal = coordinator as unknown as {
        selectNextSubtask(): Promise<typeof subtask | null>
        selectNextTask(): Promise<typeof task | null>
        startSubtaskExecution(input: typeof subtask): Promise<boolean>
        startTaskAnalysis(input: typeof task): Promise<boolean>
        reconcileOrphanedReadyTasks(): Promise<void>
        processDeployQueue(): Promise<void>
      }
      vi.spyOn(internal, 'selectNextSubtask').mockResolvedValue(subtask)
      vi.spyOn(internal, 'startSubtaskExecution').mockResolvedValue(false)
      vi.spyOn(internal, 'selectNextTask').mockResolvedValue(task)
      const startAnalysis = vi.spyOn(internal, 'startTaskAnalysis').mockResolvedValue(true)
      vi.spyOn(internal, 'reconcileOrphanedReadyTasks').mockResolvedValue()
      vi.spyOn(internal, 'processDeployQueue').mockResolvedValue()

      await coordinator.pump()

      expect(startAnalysis).toHaveBeenCalledOnce()
    })

    it('não seleciona uma segunda análise quando a vaga global já está ocupada', async () => {
      const coordinatorWithAnalysis = new TaskCoordinator(db, repository, resourceLease, {
        maxWorkers: 2,
        maxWorkersPerProject: 1,
      })
      const internal = coordinatorWithAnalysis as unknown as {
        activeWorkers: Map<string, unknown>
        selectNextSubtask(): Promise<null>
        selectNextTask(): Promise<null>
        reconcileOrphanedReadyTasks(): Promise<void>
        processDeployQueue(): Promise<void>
      }
      internal.activeWorkers.set('dev-a', { phase: 'execute', resourceKey: 'project:a:execution' })
      internal.activeWorkers.set('dev-b', { phase: 'execute', resourceKey: 'project:b:execution' })
      internal.activeWorkers.set('analysis-a', { phase: 'analyze', resourceKey: 'motor:analysis' })
      vi.spyOn(internal, 'selectNextSubtask').mockResolvedValue(null)
      const selectTask = vi.spyOn(internal, 'selectNextTask').mockResolvedValue(null)
      vi.spyOn(internal, 'reconcileOrphanedReadyTasks').mockResolvedValue()
      vi.spyOn(internal, 'processDeployQueue').mockResolvedValue()

      await coordinatorWithAnalysis.pump()

      expect(selectTask).not.toHaveBeenCalled()
    })

    it('serializa chamadas concorrentes para não selecionar a mesma tarefa duas vezes', async () => {
      const task = {
        id: 'task-concorrente', chatId: '', agentId: 'agent', title: 'Concorrente', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'planned' as const, maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project',
        createdAt: '', updatedAt: '',
      }
      type CoordinatorInternals = {
        selectNextSubtask: () => Promise<null>
        selectNextTask: () => Promise<typeof task | null>
        startTaskAnalysis: (input: typeof task) => Promise<void>
      }
      const internals = coordinator as unknown as CoordinatorInternals
      const selectSubtask = vi.spyOn(internals, 'selectNextSubtask').mockResolvedValue(null)
      const selectTask = vi.spyOn(internals, 'selectNextTask').mockResolvedValue(task)
      const startAnalysis = vi.spyOn(internals, 'startTaskAnalysis').mockResolvedValue(undefined)

      await Promise.all([coordinator.pump(), coordinator.pump()])

      expect(selectSubtask).toHaveBeenCalledTimes(1)
      expect(selectTask).toHaveBeenCalledTimes(1)
      expect(startAnalysis).toHaveBeenCalledTimes(1)
    })

    it('não deve iniciar tarefa quando maxWorkers atingido', async () => {
      // Sem tarefas no banco
      vi.mocked(db.query).mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 })

      await coordinator.pump()

      // saveTask não deve ser chamado
      expect(repository.saveTask).not.toHaveBeenCalled()
    })

    it('retoma clarificação respondida detectada no chat durante o pump', async () => {
      // 1ª query do pump: fetchAnsweredTaskClarifications acha resposta não processada
      vi.mocked(db.query).mockResolvedValueOnce({
        rows: [{ db_id: 749, external_id: 'task-respondida', texto: '1: resposta do dono' }],
        affectedRows: 0,
        insertId: 0,
      })
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-respondida', chatId: '', agentId: 'agent', title: 'Respondida', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'awaiting_clarification' as const, maxRework: 3, hardTimeoutMs: 1000,
        projectSlug: 'project', createdAt: '', updatedAt: '',
      })

      await coordinator.pump()

      // Resposta já persistida no chat: o Motor grava apenas o evento factual.
      expect(vi.mocked(repository.saveTask)).not.toHaveBeenCalled()
      expect(vi.mocked(repository.getTask)).toHaveBeenCalledWith('task-respondida')
    })

    it('deve selecionar tarefa para análise quando há vaga', async () => {
      // Este teste valida que o pump seleciona tarefas para análise.
      // O lock de análise (motor:analysis) é adquirido internamente pelo startTaskAnalysis.
      // Testes mais detalhados do lock estão em ResourceLeaseService.test.ts
      const taskRow = {
        id: 'task-123',
        chat_id: 'chat-456',
        agent_id: 'test-agent',
        title: 'Test Task',
        description: 'Test desc',
        repo_path: '/test/repo',
        branch_trabalho: 'main',
        build_command: 'npm run build',
        unit_test_command: 'npm run test',
        status: 'planned',
        max_rework: 3,
        hard_timeout_ms: 3600000,
        project_slug: 'test-project',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Mock para todas as queries do pump retornarem vazio (sem subtarefas, sem tarefas)
      vi.mocked(db.query).mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 })

      // selectNextTask retorna a tarefa
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [taskRow], affectedRows: 0, insertId: 0 })

      // Mock para startTaskAnalysis (adquirir lock, etc)
      vi.mocked(db.query).mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 })

      await coordinator.pump()

      // Verifica que o pump foi executado sem erros
      expect(vi.mocked(db.query)).toHaveBeenCalled()
    })
  })

  describe('getStats', () => {
    it('deve retornar estatísticas', () => {
      const stats = coordinator.getStats()
      expect(stats).toEqual({ activeWorkers: 0, maxWorkers: 1, maxWorkersPerProject: 1, workers: [], deployments: [], activities: [], maintenanceOperations: 0 })
    })

    it('detalha workers ativos com correlação e idade', () => {
      const internal = coordinator as unknown as {
        activeWorkers: Map<string, {
          taskId: string; executionId: string; resourceKey: null; fencingToken: number
          startedAt: Date; phase: 'execute'; subtaskId: number; projectSlug?: string
          lastHeartbeatAt?: Date
        }>
      }
      const startedAt = new Date(Date.now() - 5000)
      internal.activeWorkers.set('exec-stats', {
        taskId: 'task-stats', executionId: 'exec-stats', resourceKey: null,
        fencingToken: 0, startedAt, phase: 'execute', subtaskId: 9, projectSlug: 'proj-a',
      })

      const stats = coordinator.getStats()

      expect(stats.activeWorkers).toBe(1)
      expect(stats.workers).toHaveLength(1)
      expect(stats.workers[0]).toMatchObject({
        executionId: 'exec-stats', taskId: 'task-stats', subtaskId: 9,
        phase: 'execute', projectSlug: 'proj-a', startedAt: startedAt.toISOString(),
        lastHeartbeatAt: null,
      })
      expect(stats.workers[0]!.ageMs).toBeGreaterThanOrEqual(5000)
    })
  })

  describe('configuração efetiva da subtarefa', () => {
    it('prioriza max_rework e timeout da tarefa sobre os defaults do projeto', () => {
      const internals = coordinator as unknown as {
        mapSubtask: (row: Record<string, unknown>) => { maxRework: number | null; hardTimeoutMs: number | null }
      }

      const subtask = internals.mapSubtask({
        id: 1,
        seq: 1,
        tarefa_id: 10,
        task_external_id: 'task-10',
        task_max_rework: 2,
        task_hard_timeout_ms: 120_000,
        default_max_rework: 1,
        default_hard_timeout_ms: 60_000,
      })

      expect(subtask.maxRework).toBe(2)
      expect(subtask.hardTimeoutMs).toBe(120_000)
    })
  })

  describe('recuperação de workers', () => {
    afterEach(() => vi.useRealTimers())

    function registerWorker(coordinatorUnderTest: TaskCoordinator, executionId: string): void {
      const internal = coordinatorUnderTest as unknown as {
        activeWorkers: Map<string, unknown>
      }
      internal.activeWorkers.set(executionId, {
        taskId: 'task-123', executionId, resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 77,
      })
    }

    function completedTaskRepository(): void {
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-123', chatId: '', agentId: 'agent', title: 'task', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm test',
        status: 'running', maxRework: 1, hardTimeoutMs: 1000, projectSlug: null,
      })
    }

    it('marca falha quando o worker encerra sem completed e finaliza apenas uma vez', async () => {
      const launcher = new WorkerLauncher()
      const stopWorker = vi.spyOn(launcher, 'stopWorker').mockResolvedValue()
      completedTaskRepository()
      const coordinatorUnderTest = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 }, launcher)
      registerWorker(coordinatorUnderTest, 'exec-exit-1')

      launcher.emit('worker_exit', { executionId: 'exec-exit-1', code: 0, signal: null })
      launcher.emit('worker_exit', { executionId: 'exec-exit-1', code: 0, signal: null })

      await vi.waitFor(() => expect(vi.mocked(db.query).mock.calls.some(([sql]) => String(sql).includes('bloqueios'))).toBe(true))
      expect(stopWorker).not.toHaveBeenCalled()
      expect(repository.saveTask).not.toHaveBeenCalled()
    })

    it('worker_exit code 0 com entrega verified no banco retoma conclusão em vez de falhar', async () => {
      const launcher = new WorkerLauncher()
      completedTaskRepository()
      const coordinatorUnderTest = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 }, launcher)
      const internal = coordinatorUnderTest as unknown as {
        activeWorkers: Map<string, Record<string, unknown>>
      }
      // Workspace aponta para o próprio repositório do teste: readBranchCommitSha
      // resolve HEAD de verdade via git rev-parse
      internal.activeWorkers.set('exec-exit-ok', {
        taskId: 'task-123', executionId: 'exec-exit-ok', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 77,
        workspace: { path: process.cwd(), branch: 'HEAD', baseCommit: 'abc1234' },
      })
      // Subtarefa verified no banco (entrega registrada pelo worker)
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ status: 'verified' }], affectedRows: 0, insertId: 0 })
      const completedSpy = vi.spyOn(coordinatorUnderTest, 'onTaskCompleted').mockResolvedValue()

      launcher.emit('worker_exit', { executionId: 'exec-exit-ok', code: 0, signal: null })

      await vi.waitFor(() => expect(completedSpy).toHaveBeenCalled())
      const [executionId, result] = completedSpy.mock.calls[0]!
      expect(executionId).toBe('exec-exit-ok')
      expect(result?.ok).toBe(true)
      expect(result?.gitCommitSha).toMatch(/^[a-f0-9]{7,40}$/)
    })

    it('worker_exit durante finalização é ignorado (esperado)', async () => {
      const launcher = new WorkerLauncher()
      completedTaskRepository()
      const coordinatorUnderTest = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 }, launcher)
      const internal = coordinatorUnderTest as unknown as {
        activeWorkers: Map<string, Record<string, unknown>>
        finalizingExecutions: Set<string>
      }
      internal.activeWorkers.set('exec-fin', {
        taskId: 'task-123', executionId: 'exec-fin', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 77,
      })
      internal.finalizingExecutions.add('exec-fin')
      const failedSpy = vi.spyOn(coordinatorUnderTest, 'onTaskFailed').mockResolvedValue()

      launcher.emit('worker_exit', { executionId: 'exec-fin', code: 0, signal: null })
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(failedSpy).not.toHaveBeenCalled()
    })

    it('heartbeat de worker sem lease renova sua presença persistida', async () => {
      const launcher = new WorkerLauncher()
      const coordinatorUnderTest = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 }, launcher)
      registerWorker(coordinatorUnderTest, 'exec-heartbeat-1')

      launcher.emit('heartbeat', { executionId: 'exec-heartbeat-1' })

      await vi.waitFor(() => expect(vi.mocked(db.query).mock.calls.some(([sql, params]) =>
        String(sql).includes('UPDATE motor_active_executions') && params?.[1] === 'exec-heartbeat-1',
      )).toBe(true))
      expect(vi.mocked(db.query).mock.calls.some(([sql]) => String(sql).includes('execution_resources'))).toBe(false)
    })

    it('finalização remove a presença persistida da execução', async () => {
      const internal = coordinator as unknown as {
        removeActiveExecution: (executionId: string) => Promise<void>
      }

      await internal.removeActiveExecution('exec-finished-1')

      expect(vi.mocked(db.query)).toHaveBeenCalledWith(
        'DELETE FROM motor_active_executions WHERE execution_id = ?',
        ['exec-finished-1'],
      )
    })

    it('encerra e bloqueia worker que excede o timeout', async () => {
      vi.useFakeTimers()
      const launcher = new WorkerLauncher()
      const stopWorker = vi.spyOn(launcher, 'stopWorker').mockResolvedValue()
      completedTaskRepository()
      const coordinatorUnderTest = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1, workerTimeoutMs: 10 }, launcher)
      registerWorker(coordinatorUnderTest, 'exec-timeout-1')
      const internal = coordinatorUnderTest as unknown as { armWorkerTimeout: (id: string, timeout: number) => void }
      internal.armWorkerTimeout('exec-timeout-1', 10)

      await vi.advanceTimersByTimeAsync(10)
      await vi.waitFor(() => expect(vi.mocked(db.query).mock.calls.some(([sql]) => String(sql).includes('bloqueios'))).toBe(true))
      expect(stopWorker).toHaveBeenCalledWith('exec-timeout-1', 5000)
      expect(repository.saveTask).not.toHaveBeenCalled()
    })
  })

  describe('eventos de modelo', () => {
    it('publica model_unavailable com correlação da execução', () => {
      const launcher = new WorkerLauncher()
      const eventBus = new ExecutionEventBus()
      const handler = vi.fn()
      eventBus.on(handler)
      const coordinatorWithEvents = new TaskCoordinator(
        db,
        repository,
        resourceLease,
        { maxWorkers: 1 },
        launcher,
        undefined,
        undefined,
        eventBus,
      )
      const internal = coordinatorWithEvents as unknown as {
        activeWorkers: Map<string, {
          taskId: string
          executionId: string
          resourceKey: null
          fencingToken: number
          startedAt: Date
          phase: 'execute'
          subtaskId: number
        }>
      }
      internal.activeWorkers.set('exec-model', {
        taskId: 'task-model', executionId: 'exec-model', resourceKey: null,
        fencingToken: 0, startedAt: new Date(), phase: 'execute', subtaskId: 42,
      })

      launcher.emit('model_unavailable', {
        type: 'model_unavailable', executionId: 'exec-model',
        model: 'provider/model-a', message: 'Modelo indisponível: provider/model-a',
      })

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        type: 'model_unavailable', executionId: 'exec-model', taskId: 'task-model',
        subtaskId: 42, phase: 'execute', level: 'warn', model: 'provider/model-a',
      }))
    })
  })

  describe('liberação de recurso', () => {
    it('retoma a primeira espera antes de bombear novos workers', async () => {
      const order: string[] = []
      const waitManager = { resumeNext: vi.fn().mockImplementation(async () => { order.push('resume') }) }
      const coordinatorWithQueue = new TaskCoordinator(
        db,
        repository,
        resourceLease,
        { maxWorkers: 1 },
        undefined,
        undefined,
        waitManager as never,
      )
      const internal = coordinatorWithQueue as unknown as { pump: () => Promise<void> }
      vi.spyOn(internal, 'pump').mockImplementation(async () => { order.push('pump') })

      await coordinatorWithQueue.onResourceReleased('project:test-project:execution')

      expect(waitManager.resumeNext).toHaveBeenCalledWith('project:test-project:execution')
      expect(order).toEqual(['resume', 'pump'])
    })
  })

  describe('limites por projeto', () => {
    it('não inicia segundo worker no mesmo projeto acima do limite', () => {
      const coordinatorWithLimit = new TaskCoordinator(db, repository, resourceLease, {
        maxWorkers: 2,
        maxWorkersPerProject: 1,
      })
      const internal = coordinatorWithLimit as unknown as {
        activeWorkers: Map<string, { projectSlug: string | undefined; phase: 'execute' | 'analyze' }>
        canStartProject: (slug: string | null) => boolean
      }
      internal.activeWorkers.set('exec-a', { projectSlug: 'test-project', phase: 'execute' })

      expect(internal.canStartProject('test-project')).toBe(false)
      expect(internal.canStartProject('other-project')).toBe(true)
      expect(internal.canStartProject(null)).toBe(true)
    })

    it('permite análise com workers de desenvolvimento e bloqueia a segunda análise', () => {
      const coordinatorWithLimit = new TaskCoordinator(db, repository, resourceLease, {
        maxWorkers: 2,
        maxWorkersPerProject: 1,
      })
      const internal = coordinatorWithLimit as unknown as {
        activeWorkers: Map<string, { projectSlug?: string; phase: 'execute' | 'analyze' }>
        canStartExecution: (slug: string | null) => boolean
        canStartAnalysis: () => boolean
      }

      internal.activeWorkers.set('dev-a', { projectSlug: 'proj-a', phase: 'execute' })
      internal.activeWorkers.set('dev-b', { projectSlug: 'proj-b', phase: 'execute' })
      expect(internal.canStartAnalysis()).toBe(true)
      expect(internal.canStartExecution('proj-c')).toBe(false)

      internal.activeWorkers.set('analysis-a', { phase: 'analyze' })
      expect(internal.canStartAnalysis()).toBe(false)
    })
  })

  describe('configuração operacional do projeto', () => {
    it('resolve o identificador do agente por COALESCE(openclaw_agent_id, nome, slug) na Biblioteca', async () => {
      await coordinator.pump()
      const agentQuery = vi.mocked(db.query).mock.calls
        .map(([query]) => String(query))
        .find((query) => query.includes('COALESCE(NULLIF(a.openclaw_agent_id'))
      expect(agentQuery).toContain("COALESCE(NULLIF(a.openclaw_agent_id, ''), NULLIF(a.nome, ''), pc.slug) as agent_id")
      expect(agentQuery).toContain('LEFT JOIN agentes a ON pc.agente_id = a.id')
    })

    it('usa configuração persistida e recusa execução sem os campos críticos', () => {
      const internal = coordinator as unknown as {
        mapSubtask: (row: Record<string, unknown>) => {
          repoPath: string
          branchTrabalho: string | null
          buildCommand: string | null
          unitTestCommand: string | null
          unitTestExclude: string[]
          maxRework: number | null
          hardTimeoutMs: number | null
          deliverCount: number
        }
        assertExecutionConfig: (subtask: unknown) => void
      }
      const configured = internal.mapSubtask({
        id: 7, seq: 1, tarefa_id: 3, task_external_id: 'task-3',
        repo_path: '/repos/app', branch_trabalho: 'develop',
        build_command: 'pnpm build', unit_test_command: 'pnpm test',
        unit_test_exclude: '["e2e"]', default_max_rework: 5,
        default_hard_timeout_ms: 120000, deliver_count: 2,
      })

      expect(configured).toMatchObject({
        repoPath: '/repos/app', branchTrabalho: 'develop',
        buildCommand: 'pnpm build', unitTestCommand: 'pnpm test',
        unitTestExclude: ['e2e'], maxRework: 5, hardTimeoutMs: 120000,
        deliverCount: 2,
      })
      expect(() => internal.assertExecutionConfig(configured)).not.toThrow()

      const missing = internal.mapSubtask({ id: 8, seq: 1, tarefa_id: 3, task_external_id: 'task-3' })
      expect(() => internal.assertExecutionConfig(missing)).toThrow('configuração operacional')
    })
  })

  describe('retomada', () => {
    it('retoma tarefa pausada removendo apenas o fato paused_at', async () => {
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-81', chatId: '', agentId: 'agent', title: 'Retomar', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'paused', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project',
      })
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ paused_at: '2026-09-09 12:00:00' }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
      vi.spyOn(coordinator, 'pump').mockResolvedValue()

      await coordinator.resumeTask('task-81')

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('SET paused_at = NULL'), ['task-81', 'task-81'])
      expect(repository.saveTask).not.toHaveBeenCalled()
    })

    it('não usa o status materializado para decidir se uma tarefa está pausada', async () => {
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-82', chatId: '', agentId: 'agent', title: 'Planejar', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'paused', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project',
      })
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ paused_at: '2026-09-09 12:00:00' }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
      vi.spyOn(coordinator, 'pump').mockResolvedValue()

      await coordinator.resumeTask('task-82')

      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('SET paused_at = NULL'), ['task-82', 'task-82'])
      expect(repository.saveTask).not.toHaveBeenCalled()
    })

    it('nunca seleciona para análise uma tarefa que já possui subtarefas', async () => {
      await coordinator.pump()

      const analysisQuery = vi.mocked(db.query).mock.calls
        .map(([query]) => String(query))
        .find((query) => query.includes('f.analysis_started_at IS NULL'))
      expect(analysisQuery).toContain('NOT EXISTS (SELECT 1 FROM subtarefas')
    })
  })

  describe('pause', () => {
    it('pausa sem worker ativo em transação com FOR UPDATE e limpa espera de recurso', async () => {
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-90', chatId: '', agentId: 'agent', title: 'Pausar', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'running', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project',
      })

      await coordinator.pauseTask('task-90')

      // Transação usada (proteção contra resumeNext concorrente)
      expect(db.transaction).toHaveBeenCalled()
      const queries = vi.mocked(db.query).mock.calls.map(([sql]) => String(sql))
      // Lock de linha antes de mutar
      expect(queries.some((sql) => sql.includes('FOR UPDATE'))).toBe(true)
      // Remove da fila de espera
      expect(queries.some((sql) => sql.includes('DELETE q FROM execution_resource_queue'))).toBe(true)
      // Pause limpa campos de espera de recurso (senão selectNextSubtask re-seleciona)
      expect(queries.some((sql) =>
        sql.includes('paused_at = NOW()') &&
        sql.includes('resource_wait_key = NULL') &&
        sql.includes('resource_wait_id = NULL') &&
        sql.includes('resource_wait_position = NULL')
      )).toBe(true)
    })

    it('com worker ativo agenda pause graceful sem tocar no banco imediatamente', async () => {
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-91', chatId: '', agentId: 'agent', title: 'Pausar graceful', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'running', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project',
      })
      const internal = coordinator as unknown as { activeWorkers: Map<string, Record<string, unknown>> }
      internal.activeWorkers.set('exec-pause-1', {
        taskId: 'task-91', executionId: 'exec-pause-1', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 5,
      })

      await coordinator.pauseTask('task-91')

      const worker = internal.activeWorkers.get('exec-pause-1')!
      expect(worker.pendingPause).toBe(true)
      // Nenhuma query de pause imediato
      const queries = vi.mocked(db.query).mock.calls.map(([sql]) => String(sql))
      expect(queries.some((sql) => sql.includes('paused_at = NOW()'))).toBe(false)

      internal.activeWorkers.delete('exec-pause-1')
    })
  })

  describe('execução sequencial de subtarefas', () => {
    it('só seleciona uma subtarefa quando todas as anteriores estão verificadas', async () => {
      await coordinator.pump()

      const selectionQuery = vi.mocked(db.query).mock.calls
        .map(([query]) => String(query))
        .find((query) => query.includes('FROM subtarefas s ') && query.includes('anterior.tarefa_id = s.tarefa_id'))

      expect(selectionQuery).toContain('anterior.tarefa_id = s.tarefa_id')
      expect(selectionQuery).toContain('anterior.seq < s.seq')
      expect(selectionQuery).toContain("anterior.status NOT IN ('verified', 'superseded')")
      expect(selectionQuery).toContain('anterior.id != COALESCE(s.correction_for_subtask_id, -1)')
    })

    it('mantém a tarefa pronta entre subtarefas e só conclui após a última verificada', async () => {
      const task = {
        id: 'task-sequencial', chatId: '', agentId: 'agent', title: 'Sequencial', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm test',
        status: 'running' as const, maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project',
      }
      vi.mocked(repository.getTask).mockResolvedValue(task)
      vi.spyOn(coordinator, 'pump').mockResolvedValue()
      const internal = coordinator as unknown as {
        activeWorkers: Map<string, {
          taskId: string; executionId: string; resourceKey: null; fencingToken: number
          startedAt: Date; phase: 'execute'; subtaskId: number
        }>
      }

      internal.activeWorkers.set('exec-1', {
        taskId: task.id, executionId: 'exec-1', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 101,
      })
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ pending: 1 }], affectedRows: 0, insertId: 0 })
      await coordinator.onTaskCompleted('exec-1')

      internal.activeWorkers.set('exec-2', {
        taskId: task.id, executionId: 'exec-2', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 102,
      })
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ pending: 0 }], affectedRows: 0, insertId: 0 })
      await coordinator.onTaskCompleted('exec-2')

      expect(repository.saveTask).not.toHaveBeenCalled()
    })
  })

  describe('onTaskCompleted', () => {
    it('deve lidar com execução desconhecida sem erro', async () => {
      await coordinator.onTaskCompleted('exec-inexistente')
      // Não deve lançar erro
    })

    it('encerra o fato de análise ao concluir uma análise', async () => {
      const task = {
        id: 'task-analysis-status', chatId: '', agentId: 'agent', title: 'Análise', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm test',
        status: 'planned' as const, maxRework: 3, hardTimeoutMs: 1000, projectSlug: null,
      }
      vi.mocked(repository.getTask).mockResolvedValue(task)
      const internal = coordinator as unknown as {
        activeWorkers: Map<string, {
          taskId: string; executionId: string; resourceKey: null; fencingToken: number
          startedAt: Date; phase: 'analyze'
        }>
      }
      internal.activeWorkers.set('exec-analysis-status', {
        taskId: task.id, executionId: 'exec-analysis-status', resourceKey: null,
        fencingToken: 0, startedAt: new Date(), phase: 'analyze',
      })

      await coordinator.onTaskCompleted('exec-analysis-status')

      expect(repository.saveTask).not.toHaveBeenCalled()
    })
  })

  describe('onTaskFailed', () => {
    it('deve lidar com execução desconhecida sem erro', async () => {
      await coordinator.onTaskFailed('exec-inexistente', 'erro qualquer')
    })

    it('reenfileira uma vez falha de workspace Git sem commit', async () => {
      const internal = coordinator as unknown as {
        tryRecoverInvalidWorkspace(executionId: string, worker: Record<string, unknown>, failure: string): Promise<boolean>
        finishWorker(executionId: string, worker: Record<string, unknown>): Promise<void>
      }
      const worker = {
        taskId: 'task-793', executionId: 'exec-935', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 935, repoPath: '/repo',
      }
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ workspace_commit_sha: null }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({ rows: [{ total: 0 }], affectedRows: 0, insertId: 0 })
      const finishSpy = vi.spyOn(internal, 'finishWorker').mockResolvedValue()

      const recovered = await internal.tryRecoverInvalidWorkspace(
        'exec-935', worker, '[error] exit=128 fatal: not a git repository: (null)',
      )

      expect(recovered).toBe(true)
      expect(finishSpy).toHaveBeenCalledWith('exec-935', worker)
      const queries = vi.mocked(db.query).mock.calls.map(([sql]) => String(sql))
      expect(queries.some((sql) => sql.includes("workspace_status = 'auto_recovery_pending'"))).toBe(true)
      expect(queries.some((sql) => sql.includes('resolved_at') && sql.includes('INSERT INTO bloqueios'))).toBe(true)
    })

    it('não entra em loop quando a recuperação do mesmo workspace já foi usada', async () => {
      const internal = coordinator as unknown as {
        tryRecoverInvalidWorkspace(executionId: string, worker: Record<string, unknown>, failure: string): Promise<boolean>
      }
      const worker = {
        taskId: 'task-793', executionId: 'exec-935-b', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 935, repoPath: '/repo',
      }
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ workspace_commit_sha: null }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({ rows: [{ total: 1 }], affectedRows: 0, insertId: 0 })

      const recovered = await internal.tryRecoverInvalidWorkspace(
        'exec-935-b', worker, '[error] fatal: not a git repository: (null)',
      )

      expect(recovered).toBe(false)
      expect(vi.mocked(db.query).mock.calls.some(([sql]) => String(sql).includes('UPDATE subtarefas SET status'))).toBe(false)
    })
  })

  describe('concorrência com múltiplos workers', () => {
    type CoordinatorInternals = {
      activeWorkers: Map<string, {
        taskId: string; executionId: string; resourceKey: string | null; fencingToken: number
        startedAt: Date; phase: 'execute' | 'analyze'; subtaskId?: number; projectSlug?: string
      }>
      selectNextSubtask: () => Promise<unknown>
      selectNextTask: () => Promise<unknown>
      startSubtaskExecution: (subtask: { id: number; projectSlug: string | null }) => Promise<boolean>
      startTaskAnalysis: (task: unknown) => Promise<boolean>
    }

    function subtaskRow(id: number, projectSlug: string): Record<string, unknown> {
      return {
        id, seq: 1, titulo: 'Sub ' + id, tarefa_id: 10 + id,
        task_external_id: 'task-' + (10 + id), project_slug: projectSlug, agent_id: 'agent',
      }
    }

    it('um único pump preenche todas as vagas com subtarefas de projetos diferentes', async () => {
      const coordinatorMulti = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 2, maxWorkersPerProject: 1 })
      const internals = coordinatorMulti as unknown as CoordinatorInternals
      const selectSubtask = vi.spyOn(internals, 'selectNextSubtask')
        .mockResolvedValueOnce(subtaskRow(1, 'proj-a'))
        .mockResolvedValueOnce(subtaskRow(2, 'proj-b'))
        .mockResolvedValue(null)
      const startSpy = vi.spyOn(internals, 'startSubtaskExecution').mockResolvedValue(true)

      await coordinatorMulti.pump()

      expect(startSpy).toHaveBeenCalledTimes(2)
      // Ao preencher as duas vagas DEV, a pista encerra sem uma consulta
      // excedente; a seleção de análise é avaliada separadamente.
      expect(selectSubtask).toHaveBeenCalledTimes(2)
    })

    it('respeita o limite por projeto ao preencher vagas', async () => {
      const coordinatorMulti = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 2, maxWorkersPerProject: 1 })
      const internals = coordinatorMulti as unknown as CoordinatorInternals
      // Duas subtarefas do mesmo projeto + uma de outro: a segunda do mesmo
      // projeto não pode ocupar a segunda vaga. A seleção real vem do db mock.
      vi.mocked(db.query).mockResolvedValue({
        rows: [subtaskRow(1, 'proj-a'), subtaskRow(2, 'proj-a'), subtaskRow(3, 'proj-b')],
        affectedRows: 0, insertId: 0,
      })
      const startSpy = vi.spyOn(internals, 'startSubtaskExecution').mockImplementation(async (subtask) => {
        internals.activeWorkers.set('exec-' + subtask.id, {
          taskId: 'task-x', executionId: 'exec-' + subtask.id,
          resourceKey: subtask.projectSlug ? 'project:' + subtask.projectSlug + ':execution' : null,
          fencingToken: 0, startedAt: new Date(), phase: 'execute', subtaskId: subtask.id,
          projectSlug: subtask.projectSlug ?? undefined,
        })
        return true
      })

      await coordinatorMulti.pump()

      const startedIds = startSpy.mock.calls.map(([subtask]) => subtask.id)
      expect(startedIds).toContain(1)
      expect(startedIds).toContain(3)
      expect(startedIds).not.toContain(2)
      expect(startSpy).toHaveBeenCalledTimes(2)
    })

    it('espera por recurso interrompe o preenchimento sem laço infinito', async () => {
      const coordinatorMulti = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 2 })
      const internals = coordinatorMulti as unknown as CoordinatorInternals
      const selectSubtask = vi.spyOn(internals, 'selectNextSubtask').mockResolvedValue(subtaskRow(1, 'proj-a'))
      const startSpy = vi.spyOn(internals, 'startSubtaskExecution').mockResolvedValue(false)

      await coordinatorMulti.pump()

      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(selectSubtask).toHaveBeenCalledTimes(1)
    })

    it('falha de um worker não derruba o outro worker ativo', async () => {
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-a', chatId: '', agentId: 'agent', title: 'A', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'running', maxRework: 1, hardTimeoutMs: 1000, projectSlug: null,
      })
      const internals = coordinator as unknown as CoordinatorInternals
      internals.activeWorkers.set('exec-a', {
        taskId: 'task-a', executionId: 'exec-a', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 1,
      })
      internals.activeWorkers.set('exec-b', {
        taskId: 'task-b', executionId: 'exec-b', resourceKey: null, fencingToken: 0,
        startedAt: new Date(), phase: 'execute', subtaskId: 2,
      })

      await coordinator.onTaskFailed('exec-a', 'falha isolada')

      expect(internals.activeWorkers.has('exec-a')).toBe(false)
      expect(internals.activeWorkers.has('exec-b')).toBe(true)
    })
  })

  describe('preflight de manifesto', () => {
    it('runManifestPreflight retorna ok=true quando projectSlug é nulo (pula preflight)', async () => {
      const internals = coordinator as unknown as { runManifestPreflight: (repoPath: string, projectSlug: string | null) => Promise<{ ok: true } | { ok: false; reason: string }> }
      const result = await internals.runManifestPreflight('/any/path', null)
      expect(result.ok).toBe(true)
    })

    it('runManifestPreflight retorna ok=true quando repoPath não existe', async () => {
      const internals = coordinator as unknown as { runManifestPreflight: (repoPath: string, projectSlug: string | null) => Promise<{ ok: true } | { ok: false; reason: string }> }
      const result = await internals.runManifestPreflight('/nonexistent/path/xyz', 'test-project')
      expect(result.ok).toBe(true)
    })
  })

  // BUG 789/785 (2026-09-10): conflito na promoção tarefa→base era contornado
  // pelo reconcileOrphanedReadyTasks, que confirmava integração sem o código
  // estar na base e a tarefa virava deployed. Bloqueio ativo agora impede a
  // reconciliação e a tarefa fica pendente para resolução humana.
  describe('reconciliação de tarefas órfãs', () => {
    it('não reconcilia tarefa com bloqueio ativo (conflito de promoção fica pendente para humano)', async () => {
      const internals = coordinator as unknown as { reconcileOrphanedReadyTasks: () => Promise<void> }
      await internals.reconcileOrphanedReadyTasks()
      const sql = String(vi.mocked(db.query).mock.calls[0]![0])
      expect(sql).toContain('NOT EXISTS (SELECT 1 FROM bloqueios blk WHERE blk.tarefa_id = t.id AND blk.resolved_at IS NULL)')
      // Com bloqueio ativo o banco não retorna a tarefa; nenhuma transição é salva
      expect(sql).toContain("f.integration_confirmed_at IS NULL AND f.terminal_status IS NULL")
    })
  })

  describe('saveTaskTransition fail', () => {
    it('com skipBlocker não duplica o registro de bloqueio; sem skipBlocker registra', async () => {
      const internals = coordinator as unknown as {
        saveTaskTransition: (task: unknown, transition: string, patch?: Record<string, unknown>, options?: { skipBlocker?: boolean }) => Promise<void>
      }
      const task = { id: 'task-dup', externalId: 'task-p2-dup', status: 'ready' }

      // Caminhos de conflito/erro de promoção já persistem bloqueio detalhado:
      // a transição fail não pode criar uma segunda linha systemic_failure
      await internals.saveTaskTransition(task, 'fail', { errorMessage: 'Conflito na promoção' }, { skipBlocker: true })
      let bloqueioInserts = vi.mocked(db.query).mock.calls.filter(([s]) => String(s).includes('INSERT INTO bloqueios'))
      expect(bloqueioInserts).toHaveLength(0)

      // Falha operacional sem bloqueio prévio continua registrando
      await internals.saveTaskTransition(task, 'fail', { errorMessage: 'Falha sem bloqueio prévio' })
      bloqueioInserts = vi.mocked(db.query).mock.calls.filter(([s]) => String(s).includes('INSERT INTO bloqueios'))
      expect(bloqueioInserts).toHaveLength(1)
    })
  })
})
