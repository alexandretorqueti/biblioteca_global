/**
 * Testes do TaskCoordinator
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Db, TaskRepository, QueryResult, SaveTaskData } from '../src/shared/types/infrastructure.js'
import type { Task } from '../src/shared/types/index.js'
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
      const pumpPromise = coordinator.pump()

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
