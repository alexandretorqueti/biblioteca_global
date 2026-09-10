/**
 * Testes da trilha de auditoria de retomada de bloqueios (recovery history)
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest'
import type { Db, TaskRepository, QueryResult } from '../src/shared/types/infrastructure.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'

function createMockDb(recoveryRows: Array<Record<string, unknown>> = []): Db {
  const db: Db = {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('motor_infrastructure_recovery_history') && sql.includes('SELECT')) {
        return Promise.resolve({ rows: recoveryRows, affectedRows: 0, insertId: 0 } satisfies QueryResult)
      }
      return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
    }),
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

describe('Trilha de auditoria de retomada (recovery history)', () => {
  it('getRecoveryHistory retorna registros vinculados à tarefa com todos os campos de auditoria', async () => {
    // Mock retorna na ordem DESC (ORDER BY h.id DESC), como o SQL faria
    const mockRows = [
      {
        id: 2,
        incident_id: 'inc-002',
        original_reason: 'SSH deploy host indisponível',
        correction_applied: 'retry após restauração do host',
        resume_type: 'manual',
        resumed_by: 'user:alexandre',
        execution_id: 'recovery-inc-002',
        created_at: '2026-09-10T16:30:00.000Z',
      },
      {
        id: 1,
        incident_id: 'inc-001',
        original_reason: 'worktree corrompido após queda de energia',
        correction_applied: 'preflight consolidado: Git/branch, dependências, Console e SSH',
        resume_type: 'automatic',
        resumed_by: 'motor-v2',
        execution_id: 'recovery-inc-001',
        created_at: '2026-09-10T15:00:00.000Z',
      },
    ]
    const db = createMockDb(mockRows)
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })

    const history = await coordinator.getRecoveryHistory('task-123')

    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({
      id: 2,
      incidentId: 'inc-002',
      originalReason: 'SSH deploy host indisponível',
      correctionApplied: 'retry após restauração do host',
      resumeType: 'manual',
      resumedBy: 'user:alexandre',
      executionId: 'recovery-inc-002',
    })
    expect(history[1]).toMatchObject({
      id: 1,
      incidentId: 'inc-001',
      resumeType: 'automatic',
      resumedBy: 'motor-v2',
    })
  })

  it('getRecoveryHistory retorna lista vazia quando não há retomadas', async () => {
    const db = createMockDb([])
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })

    const history = await coordinator.getRecoveryHistory('task-sem-historico')

    expect(history).toHaveLength(0)
  })

  it('reanalyzeAndResumeInfrastructureBlock grava resume_type e resumed_by do chamador', async () => {
    const db = createMockDb()
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })

    // Mock getTask para retornar tarefa bloqueada
    vi.spyOn(repository, 'getTask').mockResolvedValue({
      id: 'task-blocked-1',
      chatId: '',
      agentId: 'test-agent',
      title: 'Tarefa bloqueada',
      description: '',
      repoPath: '/repo',
      buildCommand: 'npm run build',
      unitTestCommand: 'npm test',
      status: 'blocked' as const,
      maxRework: 3,
      hardTimeoutMs: 1000,
      projectSlug: 'test-project',
      createdAt: '',
      updatedAt: '',
    })

    // Mock query para retornar bloqueio elegível
    const queryMock = vi.spyOn(db, 'query')
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM bloqueios')) {
        return Promise.resolve({
          rows: [{
            id: 1,
            block_reason: 'blocked_environment',
            block_excerpt: 'worktree corrompido',
            subtarefa_id: 10,
            workspace_path: '/tmp/worktree',
            workspace_branch: 'motor-v2/test',
            workspace_base_commit: 'abc123',
            repo_path: '/repo',
          }],
          affectedRows: 0,
          insertId: 0,
        } satisfies QueryResult)
      }
      return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
    })

    // Mock workspaceManager.reuseExisting
    const coordinatorInternal = coordinator as unknown as {
      workspaceManager: { reuseExisting: (opts: unknown) => Promise<{ projectPath: string }> }
      verifyAgentBeforeEnqueue: (agentId: string) => Promise<{ ok: boolean; report?: string }>
      recoveryWorkspaces: Map<number, unknown>
      saveTaskTransition: () => Promise<void>
      pump: () => Promise<void>
      activeWorkers: Map<string, unknown>
    }
    coordinatorInternal.workspaceManager = {
      reuseExisting: vi.fn().mockResolvedValue({ projectPath: '/repo' }),
    } as unknown as typeof coordinatorInternal.workspaceManager
    coordinatorInternal.verifyAgentBeforeEnqueue = vi.fn().mockResolvedValue({ ok: true })
    coordinatorInternal.recoveryWorkspaces = new Map()
    coordinatorInternal.saveTaskTransition = vi.fn().mockResolvedValue(undefined)
    coordinatorInternal.pump = vi.fn().mockResolvedValue(undefined)
    coordinatorInternal.activeWorkers = new Map()

    await coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-1', {
      resumeType: 'manual',
      resumedBy: 'user:alexandre',
    })

    // Verifica que o INSERT inclui resume_type e resumed_by
    const insertCall = queryMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO motor_infrastructure_recovery_history')
    )
    expect(insertCall).toBeDefined()
    const params = insertCall![1] as unknown[]
    // params: [subtarefaId, incidentId, excerpt, correction, resumeType, resumedBy, executionId, taskId, taskId]
    expect(params[4]).toBe('manual')
    expect(params[5]).toBe('user:alexandre')
  })

  it('reanalyzeAndResumeInfrastructureBlock default para automatic/motor-v2 quando sem opções', async () => {
    const db = createMockDb()
    const repository = createMockRepository()
    const resourceLease = new ResourceLeaseService({ db })
    const coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })

    vi.spyOn(repository, 'getTask').mockResolvedValue({
      id: 'task-blocked-2',
      chatId: '',
      agentId: 'test-agent',
      title: 'Tarefa bloqueada',
      description: '',
      repoPath: '/repo',
      buildCommand: 'npm run build',
      unitTestCommand: 'npm test',
      status: 'blocked' as const,
      maxRework: 3,
      hardTimeoutMs: 1000,
      projectSlug: 'test-project',
      createdAt: '',
      updatedAt: '',
    })

    const queryMock = vi.spyOn(db, 'query')
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM bloqueios')) {
        return Promise.resolve({
          rows: [{
            id: 2,
            block_reason: 'systemic_failure',
            block_excerpt: 'Console indisponível',
            subtarefa_id: 20,
            workspace_path: '/tmp/worktree2',
            workspace_branch: 'motor-v2/test2',
            workspace_base_commit: 'def456',
            repo_path: '/repo',
          }],
          affectedRows: 0,
          insertId: 0,
        } satisfies QueryResult)
      }
      return Promise.resolve({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult)
    })

    const coordinatorInternal = coordinator as unknown as {
      workspaceManager: { reuseExisting: (opts: unknown) => Promise<{ projectPath: string }> }
      verifyAgentBeforeEnqueue: (agentId: string) => Promise<{ ok: boolean; report?: string }>
      recoveryWorkspaces: Map<number, unknown>
      saveTaskTransition: () => Promise<void>
      pump: () => Promise<void>
      activeWorkers: Map<string, unknown>
    }
    coordinatorInternal.workspaceManager = {
      reuseExisting: vi.fn().mockResolvedValue({ projectPath: '/repo' }),
    } as unknown as typeof coordinatorInternal.workspaceManager
    coordinatorInternal.verifyAgentBeforeEnqueue = vi.fn().mockResolvedValue({ ok: true })
    coordinatorInternal.recoveryWorkspaces = new Map()
    coordinatorInternal.saveTaskTransition = vi.fn().mockResolvedValue(undefined)
    coordinatorInternal.pump = vi.fn().mockResolvedValue(undefined)
    coordinatorInternal.activeWorkers = new Map()

    await coordinator.reanalyzeAndResumeInfrastructureBlock('task-blocked-2')

    const insertCall = queryMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO motor_infrastructure_recovery_history')
    )
    expect(insertCall).toBeDefined()
    const params = insertCall![1] as unknown[]
    expect(params[4]).toBe('automatic')
    expect(params[5]).toBe('motor-v2')
  })
})
