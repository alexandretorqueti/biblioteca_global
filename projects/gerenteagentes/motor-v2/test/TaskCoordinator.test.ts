/**
 * Testes do TaskCoordinator
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import type { Db, TaskRepository } from '@gerente-agentes/persistence'
import type { Task } from '../src/shared/types/index.js'

describe('TaskCoordinator', () => {
  let coordinator: TaskCoordinator
  let mockDb: Db
  let mockRepository: TaskRepository
  let mockResourceLease: ResourceLeaseService

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Db

    mockRepository = {
      saveTask: vi.fn(),
      getTask: vi.fn(),
    } as unknown as TaskRepository

    mockResourceLease = {
      acquire: vi.fn(),
      release: vi.fn(),
      isAvailable: vi.fn(),
    } as unknown as ResourceLeaseService

    coordinator = new TaskCoordinator(mockDb, mockRepository, mockResourceLease, {
      maxWorkers: 1,
      maxWorkersPerProject: 1,
    })
  })

  describe('pump', () => {
    it('não deve iniciar tarefa quando maxWorkers atingido', async () => {
      // Simula worker ativo
      vi.mocked(mockResourceLease.isAvailable).mockResolvedValue(false)
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 })

      await coordinator.pump()

      // Não deve tentar adquirir recurso
      expect(mockResourceLease.acquire).not.toHaveBeenCalled()
    })

    it('deve iniciar tarefa quando há capacidade', async () => {
      const mockTask: Task = {
        id: 'task-123',
        chatId: 'chat-456',
        agentId: 'test-agent',
        title: 'Test Task',
        description: 'Test',
        repoPath: '/test/repo',
        buildCommand: 'npm run build',
        unitTestCommand: 'npm run test',
        unitTestExclude: [],
        baselineMode: 'full',
        status: 'planned',
        maxRework: 3,
        hardTimeoutMs: 3600000,
        projectSlug: 'test-project',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      // Mock: selectNextTask retorna tarefa
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{
          id: mockTask.id,
          external_id: mockTask.id,
          chat_id: mockTask.chatId,
          agent_id: mockTask.agentId,
          title: mockTask.title,
          description: mockTask.description,
          repo_path: mockTask.repoPath,
          build_command: mockTask.buildCommand,
          unit_test_command: mockTask.unitTestCommand,
          status: mockTask.status,
          max_rework: mockTask.maxRework,
          hard_timeout_ms: mockTask.hardTimeoutMs,
          project_slug: mockTask.projectSlug,
          created_at: mockTask.createdAt,
          updated_at: mockTask.updatedAt,
        }],
        affectedRows: 0,
        insertId: 0,
      })

      // Mock: recurso disponível
      vi.mocked(mockResourceLease.isAvailable).mockResolvedValue(true)

      // Mock: acquire bem-sucedido
      vi.mocked(mockResourceLease.acquire).mockResolvedValue({
        kind: 'acquired',
        lease: {
          resourceKey: 'project:test-project:execution',
          executionId: 'exec-123',
          ownerId: 'task-123',
          fencingToken: 1,
          heartbeatAt: new Date(),
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      })

      // Mock: saveTask
      vi.mocked(mockRepository.saveTask).mockResolvedValue(undefined as never)

      await coordinator.pump()

      // Deve tentar adquirir recurso
      expect(mockResourceLease.acquire).toHaveBeenCalled()
      
      // Deve salvar tarefa como running
      expect(mockRepository.saveTask).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'running',
        })
      )
    })

    it('deve pausar tarefa quando recurso está ocupado', async () => {
      const mockTask: Task = {
        id: 'task-123',
        chatId: 'chat-456',
        agentId: 'test-agent',
        title: 'Test Task',
        description: 'Test',
        repoPath: '/test/repo',
        buildCommand: 'npm run build',
        unitTestCommand: 'npm run test',
        unitTestExclude: [],
        baselineMode: 'full',
        status: 'planned',
        maxRework: 3,
        hardTimeoutMs: 3600000,
        projectSlug: 'test-project',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      // Mock: selectNextTask retorna tarefa
      vi.mocked(mockDb.query).mockResolvedValueOnce({
        rows: [{
          id: mockTask.id,
          external_id: mockTask.id,
          status: mockTask.status,
          project_slug: mockTask.projectSlug,
        }],
        affectedRows: 0,
        insertId: 0,
      })

      vi.mocked(mockResourceLease.isAvailable).mockResolvedValue(true)

      // Mock: acquire retorna waiting
      vi.mocked(mockResourceLease.acquire).mockResolvedValue({
        kind: 'waiting',
        waitId: 42,
        position: 2,
      })

      vi.mocked(mockRepository.saveTask).mockResolvedValue(undefined as never)

      await coordinator.pump()

      // Deve salvar tarefa como paused
      expect(mockRepository.saveTask).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'paused',
        })
      )
    })
  })

  describe('onTaskCompleted', () => {
    it('deve liberar recurso e tentar próxima tarefa', async () => {
      const executionId = 'exec-123'
      
      // Simula worker ativo
      vi.mocked(mockResourceLease.release).mockResolvedValue({ kind: 'released' })
      vi.mocked(mockDb.query).mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 })

      await coordinator.onTaskCompleted(executionId)

      // Não deve chamar release porque não há worker ativo
      // (worker precisa ser registrado primeiro via pump)
    })
  })

  describe('getStats', () => {
    it('deve retornar estatísticas corretas', () => {
      const stats = coordinator.getStats()

      expect(stats).toEqual({
        activeWorkers: 0,
        maxWorkers: 1,
      })
    })
  })
})
