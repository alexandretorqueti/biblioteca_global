/**
 * Testes do TaskCoordinator
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Db, TaskRepository, QueryResult } from '../src/shared/types/infrastructure.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'

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

      // Aguarda queries de lock serem executadas (até 2s)
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          const calls = vi.mocked(db.query).mock.calls
          const lockInsert = calls.find(c => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO projeto_640.execution_resources'))
          if (lockInsert) {
            clearInterval(check)
            resolve()
          }
        }, 50)
        setTimeout(() => { clearInterval(check); resolve() }, 2000)
      })

      // Verifica que o INSERT do lock foi feito
      const calls = vi.mocked(db.query).mock.calls
      const lockInsertCall = calls.find(c => typeof c[0] === 'string' && String(c[0]).includes('INSERT INTO projeto_640.execution_resources'))
      expect(lockInsertCall).toBeDefined()

      // Limpa: não esperamos o pump completar
      // (O worker spawn vai timeout em 30s, mas o teste já validou o que precisava)
    }, 10000)
  })

  describe('getStats', () => {
    it('deve retornar estatísticas', () => {
      const stats = coordinator.getStats()
      expect(stats).toEqual({ activeWorkers: 0, maxWorkers: 1 })
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
})
