/**
 * Testes do TaskCoordinator
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

    it('deve adquirir lock quando seleciona tarefa', async () => {
      const taskRow = {
        id: 'task-123',
        chat_id: 'chat-456',
        agent_id: 'test-agent',
        title: 'Test Task',
        description: 'Test desc',
        repo_path: '/test/repo',
        build_command: 'npm run build',
        unit_test_command: 'npm run test',
        status: 'planned',
        max_rework: 3,
        hard_timeout_ms: 3600000,
        project_slug: 'test-project',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // selectNextTask retorna a tarefa
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [taskRow], affectedRows: 0, insertId: 0 })

      // acquire: SELECT dentro da transaction (recurso livre)
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
      // acquire: INSERT
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 1 })

      // Inicia pump mas não espera completar (worker spawn demora 30s para timeout)
      void coordinator.pump()

      // Aguarda queries de lock serem executadas (até 15s — margem para
      // ambientes sob carga: antes 2s causava flake em gate concorrido, e 8s
      // ainda reprovava na suíte cheia do container — B11, caso subtarefa 731)
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          const calls = vi.mocked(db.query).mock.calls
          const lockInsert = calls.find(c => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO projeto_640.execution_resources'))
          if (lockInsert) {
            clearInterval(check)
            resolve()
          }
        }, 50)
        setTimeout(() => { clearInterval(check); resolve() }, 15000)
      })

      // Verifica que o INSERT do lock foi feito
      const calls = vi.mocked(db.query).mock.calls
      const lockInsertCall = calls.find(c => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO projeto_640.execution_resources'))
      expect(lockInsertCall).toBeDefined()

      // Limpa: não esperamos o pump completar
      // (O worker spawn vai timeout em 30s, mas o teste já validou o que precisava)
    }, 40000)
  })

  describe('getStats', () => {
    it('deve retornar estatísticas', () => {
      const stats = coordinator.getStats()
      expect(stats).toEqual({ activeWorkers: 0, maxWorkers: 1, maxWorkersPerProject: 1, workers: [] })
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

      await vi.waitFor(() => expect(repository.saveTask).toHaveBeenCalled())
      expect(stopWorker).not.toHaveBeenCalled()
      expect(repository.saveTask).toHaveBeenCalledTimes(1)
      expect(repository.saveTask.mock.calls[0]?.[0].errorMessage).toContain('[worker_exit]')
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
      await vi.waitFor(() => expect(repository.saveTask).toHaveBeenCalled())
      expect(stopWorker).toHaveBeenCalledWith('exec-timeout-1', 5000)
      expect(repository.saveTask.mock.calls[0]?.[0].errorMessage).toContain('[timeout]')
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
        activeWorkers: Map<string, { resourceKey: string | null }>
        canStartProject: (slug: string | null) => boolean
      }
      internal.activeWorkers.set('exec-a', { resourceKey: 'project:test-project:execution' })

      expect(internal.canStartProject('test-project')).toBe(false)
      expect(internal.canStartProject('other-project')).toBe(true)
      expect(internal.canStartProject(null)).toBe(true)
    })
  })

  describe('configuração operacional do projeto', () => {
    it('resolve o identificador do agente pela chave existente na Biblioteca', async () => {
      await coordinator.pump()
      const firstQuery = vi.mocked(db.query).mock.calls[0]?.[0]
      expect(firstQuery).toContain('a.nome as agent_id')
      expect(firstQuery).not.toContain('openclaw_agent_id')
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
    it('retoma tarefa pausada com plano como ready, sem replanejar', async () => {
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-81', chatId: '', agentId: 'agent', title: 'Retomar', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'paused', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project',
      })
      vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ has_plan: 1 }], affectedRows: 0, insertId: 0 })
      vi.spyOn(coordinator, 'pump').mockResolvedValue()

      await coordinator.resumeTask('task-81')

      expect(repository.saveTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-81', status: 'ready' }))
    })

    it('retoma tarefa pausada sem plano como planned, para análise inicial', async () => {
      vi.mocked(repository.getTask).mockResolvedValue({
        id: 'task-82', chatId: '', agentId: 'agent', title: 'Planejar', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'paused', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'project',
      })
      vi.mocked(db.query).mockResolvedValue({ rows: [{ has_plan: 0 }], affectedRows: 0, insertId: 0 })
      vi.spyOn(coordinator, 'pump').mockResolvedValue()

      await coordinator.resumeTask('task-82')

      expect(repository.saveTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-82', status: 'planned' }))
    })

    it('nunca seleciona para análise uma tarefa que já possui subtarefas', async () => {
      await coordinator.pump()

      const analysisQuery = vi.mocked(db.query).mock.calls
        .map(([query]) => String(query))
        .find((query) => query.includes("FROM projeto_640.tarefas t"))
      expect(analysisQuery).toContain('NOT EXISTS (SELECT 1 FROM projeto_640.subtarefas')
    })
  })

  describe('execução sequencial de subtarefas', () => {
    it('só seleciona uma subtarefa quando todas as anteriores estão verificadas', async () => {
      await coordinator.pump()

      const selectionQuery = vi.mocked(db.query).mock.calls
        .map(([query]) => String(query))
        .find((query) => query.includes('FROM projeto_640.subtarefas s'))

      expect(selectionQuery).toContain('anterior.tarefa_id = s.tarefa_id')
      expect(selectionQuery).toContain('anterior.seq < s.seq')
      expect(selectionQuery).toContain("anterior.status != 'verified'")
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

      expect(repository.saveTask).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'ready' }))
      expect(repository.saveTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'completed' }))
    })
  })

  describe('onTaskCompleted', () => {
    it('deve lidar com execução desconhecida sem erro', async () => {
      await coordinator.onTaskCompleted('exec-inexistente')
      // Não deve lançar erro
    })
  })

  describe('onTaskFailed', () => {
    it('deve lidar com execução desconhecida sem erro', async () => {
      await coordinator.onTaskFailed('exec-inexistente', 'erro qualquer')
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
      expect(selectSubtask).toHaveBeenCalledTimes(3)
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
})
