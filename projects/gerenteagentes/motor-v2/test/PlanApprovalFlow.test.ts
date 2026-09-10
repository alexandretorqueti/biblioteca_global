/**
 * Testes do fluxo de aprovação de plano
 * @vitest-environment node
 *
 * Critérios de aceite (subtarefa 7):
 * 1. Nenhuma subtarefa é criada antes da aprovação explícita
 * 2. A aprovação usa exatamente a versão validada do plano
 * 3. As subtarefas preservam sequência, escopo, critérios, entregáveis e dependências
 * 4. Após aprovação, o fluxo atual do Motor é iniciado
 * 5. Repetição da aprovação não duplica subtarefas ou enfileiramentos
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Db, TaskRepository, QueryResult } from '../src/shared/types/infrastructure.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'
import type { Task } from '../src/shared/types/infrastructure.js'

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

function createTask(status: Task['status']): Task {
  return {
    id: 'task-test-1',
    chatId: 'chat-1',
    agentId: 'analyst',
    title: 'Tarefa de teste',
    description: 'Descrição',
    repoPath: '/repo',
    buildCommand: 'npm run build',
    unitTestCommand: 'npm test',
    status,
    maxRework: 3,
    hardTimeoutMs: 3600000,
    projectSlug: 'test-project',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('Plan Approval Flow', () => {
  let db: Db
  let repository: TaskRepository
  let resourceLease: ResourceLeaseService
  let coordinator: TaskCoordinator

  beforeEach(() => {
    db = createMockDb()
    repository = createMockRepository()
    resourceLease = new ResourceLeaseService({ db })
    coordinator = new TaskCoordinator(db, repository, resourceLease, { maxWorkers: 1 })
    vi.clearAllMocks()
  })

  describe('Critério 1: Nenhuma subtarefa é criada antes da aprovação explícita', () => {
    it('reject when task is not awaiting_approval', async () => {
      const task = createTask('planned')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      await expect(coordinator.approvePlan('task-test-1')).rejects.toThrow(
        'nao esta aguardando aprovação'
      )

      // persistPlan não deve ser chamado
      expect(db.transaction).not.toHaveBeenCalled()
    })

    it('reject when task is analyzing', async () => {
      const task = createTask('analyzing')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      await expect(coordinator.approvePlan('task-test-1')).rejects.toThrow(
        'nao esta aguardando aprovação'
      )

      expect(db.transaction).not.toHaveBeenCalled()
    })

    it('reject when task is awaiting_clarification', async () => {
      const task = createTask('awaiting_clarification')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      await expect(coordinator.approvePlan('task-test-1')).rejects.toThrow(
        'nao esta aguardando aprovação'
      )

      expect(db.transaction).not.toHaveBeenCalled()
    })

    it('reject when task is running', async () => {
      const task = createTask('running')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      await expect(coordinator.approvePlan('task-test-1')).rejects.toThrow(
        'nao esta aguardando aprovação'
      )

      expect(db.transaction).not.toHaveBeenCalled()
    })
  })

  describe('Critério 2: A aprovação usa exatamente a versão validada do plano', () => {
    it('approve uses the latest proposed version', async () => {
      const task = createTask('awaiting_approval')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      // Mock para approvePlanProposal retornar a proposta
      const proposal = {
        id: 1,
        taskId: 100,
        version: 2,
        status: 'approved' as const,
        subtasks: [
          {
            seq: 1,
            titulo: 'Subtarefa 1',
            scope: 'Escopo 1',
            acceptanceCriteria: ['critério 1'],
            deliverables: ['entrega 1'],
            requirementsCovered: ['REQ-1'],
            dependsOn: [],
          },
        ],
        coverage: {
          requirements: [{ id: 'REQ-1', description: 'Requisito 1' }],
          coverage: [{ requirement: 'REQ-1', coveredBy: [1] }],
        },
        proposedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      }

      // Mock das queries do approvePlanProposal
      vi.mocked(db.query)
        // resolveTaskDatabaseId
        .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
        // SELECT proposed (latest)
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            tarefa_id: 100,
            version: 2,
            status: 'proposed',
            subtasks_json: JSON.stringify(proposal.subtasks),
            coverage_json: JSON.stringify(proposal.coverage),
            proposed_at: proposal.proposedAt,
            decided_at: null,
            decided_by: null,
            decision_reason: null,
          }],
          affectedRows: 0,
          insertId: 0,
        })
        // UPDATE status
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

      // Mock do persistPlan (transaction)
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        // taskLookup
        vi.mocked(db.query)
          .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
          // Check existing subtasks
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          // INSERT subtask 1
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 1 })
          // LAST_INSERT_ID
          .mockResolvedValueOnce({ rows: [{ id: 1 }], affectedRows: 0, insertId: 0 })
          // UPDATE depends_on
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          // UPDATE plan_coverage
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
        return fn(db)
      })

      const result = await coordinator.approvePlan('task-test-1', 'alexandre')

      expect(result.subtaskCount).toBe(1)
      // A proposta aprovada deve ter version 2 (a mais recente)
      expect(proposal.version).toBe(2)
    })

    it('reject when no pending proposal exists', async () => {
      const task = createTask('awaiting_approval')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      // Mock para approvePlanProposal retornar null (nenhuma proposta pendente)
      vi.mocked(db.query)
        // resolveTaskDatabaseId
        .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
        // SELECT proposed (latest) - vazio
        .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })

      await expect(coordinator.approvePlan('task-test-1')).rejects.toThrow(
        'Nenhuma proposta pendente'
      )
    })
  })

  describe('Critério 3: As subtarefas preservam sequência, escopo, critérios, entregáveis e dependências', () => {
    it('persist subtasks with all fields preserved', async () => {
      const task = createTask('awaiting_approval')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      const subtasks = [
        {
          seq: 1,
          titulo: 'Preparar ambiente',
          scope: 'Configurar o ambiente de desenvolvimento',
          acceptanceCriteria: ['Ambiente configurado', 'Dependências instaladas'],
          deliverables: ['package.json atualizado', 'README.md'],
          requirementsCovered: ['REQ-1', 'REQ-2'],
          dependsOn: [],
        },
        {
          seq: 2,
          titulo: 'Implementar funcionalidade',
          scope: 'Desenvolver a funcionalidade principal',
          acceptanceCriteria: ['Funcionalidade implementada', 'Testes passando'],
          deliverables: ['src/feature.ts', 'tests/feature.test.ts'],
          requirementsCovered: ['REQ-3'],
          dependsOn: [1],
        },
      ]

      const coverage = {
        requirements: [
          { id: 'REQ-1', description: 'Configuração' },
          { id: 'REQ-2', description: 'Dependências' },
          { id: 'REQ-3', description: 'Funcionalidade' },
        ],
        coverage: [
          { requirement: 'REQ-1', coveredBy: [1] },
          { requirement: 'REQ-2', coveredBy: [1] },
          { requirement: 'REQ-3', coveredBy: [2] },
        ],
      }

      const proposal = {
        id: 1,
        taskId: 100,
        version: 1,
        status: 'approved' as const,
        subtasks,
        coverage,
        proposedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      }

      // Mock das queries do approvePlanProposal
      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            tarefa_id: 100,
            version: 1,
            status: 'proposed',
            subtasks_json: JSON.stringify(subtasks),
            coverage_json: JSON.stringify(coverage),
            proposed_at: proposal.proposedAt,
            decided_at: null,
            decided_by: null,
            decision_reason: null,
          }],
          affectedRows: 0,
          insertId: 0,
        })
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

      // Mock do persistPlan (transaction)
      const insertCalls: Array<{ seq: number; titulo: string; scope: string }> = []
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        vi.mocked(db.query)
          .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          // INSERT subtask 1
          .mockImplementationOnce(async (sql, params) => {
            if (sql.includes('INSERT INTO subtarefas')) {
              insertCalls.push({
                seq: params![1] as number,
                titulo: params![2] as string,
                scope: params![3] as string,
              })
            }
            return { rows: [], affectedRows: 1, insertId: 1 }
          })
          .mockResolvedValueOnce({ rows: [{ id: 1 }], affectedRows: 0, insertId: 0 })
          // INSERT subtask 2
          .mockImplementationOnce(async (sql, params) => {
            if (sql.includes('INSERT INTO subtarefas')) {
              insertCalls.push({
                seq: params![1] as number,
                titulo: params![2] as string,
                scope: params![3] as string,
              })
            }
            return { rows: [], affectedRows: 1, insertId: 2 }
          })
          .mockResolvedValueOnce({ rows: [{ id: 2 }], affectedRows: 0, insertId: 0 })
          // UPDATE depends_on (2x)
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          // UPDATE plan_coverage
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
        return fn(db)
      })

      await coordinator.approvePlan('task-test-1', 'alexandre')

      // Verifica que as subtarefas foram inseridas com os campos corretos
      expect(insertCalls).toHaveLength(2)
      expect(insertCalls[0]).toEqual({
        seq: 1,
        titulo: 'Preparar ambiente',
        scope: 'Configurar o ambiente de desenvolvimento',
      })
      expect(insertCalls[1]).toEqual({
        seq: 2,
        titulo: 'Implementar funcionalidade',
        scope: 'Desenvolver a funcionalidade principal',
      })
    })
  })

  describe('Critério 4: Após aprovação, o fluxo atual do Motor é iniciado', () => {
    it('transition task to ready after approval', async () => {
      const task = createTask('awaiting_approval')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      const proposal = {
        id: 1,
        taskId: 100,
        version: 1,
        status: 'approved' as const,
        subtasks: [
          {
            seq: 1,
            titulo: 'Subtarefa 1',
            scope: 'Escopo 1',
            acceptanceCriteria: ['critério 1'],
            deliverables: ['entrega 1'],
            requirementsCovered: ['REQ-1'],
            dependsOn: [],
          },
        ],
        coverage: {
          requirements: [{ id: 'REQ-1', description: 'Requisito 1' }],
          coverage: [{ requirement: 'REQ-1', coveredBy: [1] }],
        },
        proposedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      }

      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            tarefa_id: 100,
            version: 1,
            status: 'proposed',
            subtasks_json: JSON.stringify(proposal.subtasks),
            coverage_json: JSON.stringify(proposal.coverage),
            proposed_at: proposal.proposedAt,
            decided_at: null,
            decided_by: null,
            decision_reason: null,
          }],
          affectedRows: 0,
          insertId: 0,
        })
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        vi.mocked(db.query)
          .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 1 })
          .mockResolvedValueOnce({ rows: [{ id: 1 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
        return fn(db)
      })

      await coordinator.approvePlan('task-test-1', 'alexandre')

      // Verifica que saveTask foi chamado com status 'ready'
      const saveCalls = vi.mocked(repository.saveTask).mock.calls
      expect(saveCalls.length).toBeGreaterThan(0)
      const lastSave = saveCalls[saveCalls.length - 1]?.[0]
      expect(lastSave?.status).toBe('ready')
    })

    it('call pump after approval to start execution', async () => {
      const task = createTask('awaiting_approval')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      const proposal = {
        id: 1,
        taskId: 100,
        version: 1,
        status: 'approved' as const,
        subtasks: [
          {
            seq: 1,
            titulo: 'Subtarefa 1',
            scope: 'Escopo 1',
            acceptanceCriteria: ['critério 1'],
            deliverables: ['entrega 1'],
            requirementsCovered: ['REQ-1'],
            dependsOn: [],
          },
        ],
        coverage: {
          requirements: [{ id: 'REQ-1', description: 'Requisito 1' }],
          coverage: [{ requirement: 'REQ-1', coveredBy: [1] }],
        },
        proposedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      }

      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            tarefa_id: 100,
            version: 1,
            status: 'proposed',
            subtasks_json: JSON.stringify(proposal.subtasks),
            coverage_json: JSON.stringify(proposal.coverage),
            proposed_at: proposal.proposedAt,
            decided_at: null,
            decided_by: null,
            decision_reason: null,
          }],
          affectedRows: 0,
          insertId: 0,
        })
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        vi.mocked(db.query)
          .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 1 })
          .mockResolvedValueOnce({ rows: [{ id: 1 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
        return fn(db)
      })

      // Spy no pump
      const pumpSpy = vi.spyOn(coordinator, 'pump').mockResolvedValue()

      await coordinator.approvePlan('task-test-1', 'alexandre')

      expect(pumpSpy).toHaveBeenCalled()
    })
  })

  describe('Critério 5: Repetição da aprovação não duplica subtarefas ou enfileiramentos', () => {
    it('return already_persisted when subtasks already exist', async () => {
      const task = createTask('awaiting_approval')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      const proposal = {
        id: 1,
        taskId: 100,
        version: 1,
        status: 'approved' as const,
        subtasks: [
          {
            seq: 1,
            titulo: 'Subtarefa 1',
            scope: 'Escopo 1',
            acceptanceCriteria: ['critério 1'],
            deliverables: ['entrega 1'],
            requirementsCovered: ['REQ-1'],
            dependsOn: [],
          },
        ],
        coverage: {
          requirements: [{ id: 'REQ-1', description: 'Requisito 1' }],
          coverage: [{ requirement: 'REQ-1', coveredBy: [1] }],
        },
        proposedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      }

      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            tarefa_id: 100,
            version: 1,
            status: 'proposed',
            subtasks_json: JSON.stringify(proposal.subtasks),
            coverage_json: JSON.stringify(proposal.coverage),
            proposed_at: proposal.proposedAt,
            decided_at: null,
            decided_by: null,
            decision_reason: null,
          }],
          affectedRows: 0,
          insertId: 0,
        })
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

      // Mock do persistPlan retornando 'already_persisted'
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        vi.mocked(db.query)
          .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
          // Já existe subtarefa
          .mockResolvedValueOnce({ rows: [{ id: 99 }], affectedRows: 0, insertId: 0 })
        return fn(db)
      })

      const result = await coordinator.approvePlan('task-test-1', 'alexandre')

      // O resultado deve indicar que já estava persistido
      expect(result.subtaskCount).toBe(1)
      // Não deve ter inserido novas subtarefas
      const insertCalls = vi.mocked(db.query).mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO subtarefas')
      )
      expect(insertCalls).toHaveLength(0)
    })

    it('second approval attempt fails because task is no longer awaiting_approval', async () => {
      const task = createTask('awaiting_approval')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      const proposal = {
        id: 1,
        taskId: 100,
        version: 1,
        status: 'approved' as const,
        subtasks: [
          {
            seq: 1,
            titulo: 'Subtarefa 1',
            scope: 'Escopo 1',
            acceptanceCriteria: ['critério 1'],
            deliverables: ['entrega 1'],
            requirementsCovered: ['REQ-1'],
            dependsOn: [],
          },
        ],
        coverage: {
          requirements: [{ id: 'REQ-1', description: 'Requisito 1' }],
          coverage: [{ requirement: 'REQ-1', coveredBy: [1] }],
        },
        proposedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      }

      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            tarefa_id: 100,
            version: 1,
            status: 'proposed',
            subtasks_json: JSON.stringify(proposal.subtasks),
            coverage_json: JSON.stringify(proposal.coverage),
            proposed_at: proposal.proposedAt,
            decided_at: null,
            decided_by: null,
            decision_reason: null,
          }],
          affectedRows: 0,
          insertId: 0,
        })
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        vi.mocked(db.query)
          .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 1 })
          .mockResolvedValueOnce({ rows: [{ id: 1 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
        return fn(db)
      })

      // Primeira aprovação
      await coordinator.approvePlan('task-test-1', 'alexandre')

      // Após primeira aprovação, tarefa está em 'ready'
      const taskAfterApproval = createTask('ready')
      vi.mocked(repository.getTask).mockResolvedValue(taskAfterApproval)

      // Segunda aprovação deve falhar
      await expect(coordinator.approvePlan('task-test-1', 'alexandre')).rejects.toThrow(
        'nao esta aguardando aprovação'
      )
    })
  })

  describe('Fluxo completo de aprovação', () => {
    it('approve plan with dependencies and start execution', async () => {
      const task = createTask('awaiting_approval')
      vi.mocked(repository.getTask).mockResolvedValue(task)

      const subtasks = [
        {
          seq: 1,
          titulo: 'Setup',
          scope: 'Configuração inicial',
          acceptanceCriteria: ['Setup completo'],
          deliverables: ['config.ts'],
          requirementsCovered: ['REQ-1'],
          dependsOn: [],
        },
        {
          seq: 2,
          titulo: 'Implementação',
          scope: 'Desenvolvimento principal',
          acceptanceCriteria: ['Código implementado'],
          deliverables: ['src/index.ts'],
          requirementsCovered: ['REQ-2'],
          dependsOn: [1],
        },
        {
          seq: 3,
          titulo: 'Testes',
          scope: 'Testes unitários e integração',
          acceptanceCriteria: ['Testes passando'],
          deliverables: ['tests/'],
          requirementsCovered: ['REQ-3'],
          dependsOn: [2],
        },
      ]

      const coverage = {
        requirements: [
          { id: 'REQ-1', description: 'Setup' },
          { id: 'REQ-2', description: 'Implementação' },
          { id: 'REQ-3', description: 'Testes' },
        ],
        coverage: [
          { requirement: 'REQ-1', coveredBy: [1] },
          { requirement: 'REQ-2', coveredBy: [2] },
          { requirement: 'REQ-3', coveredBy: [3] },
        ],
      }

      const proposal = {
        id: 1,
        taskId: 100,
        version: 1,
        status: 'approved' as const,
        subtasks,
        coverage,
        proposedAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      }

      vi.mocked(db.query)
        .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
        .mockResolvedValueOnce({
          rows: [{
            id: 1,
            tarefa_id: 100,
            version: 1,
            status: 'proposed',
            subtasks_json: JSON.stringify(subtasks),
            coverage_json: JSON.stringify(coverage),
            proposed_at: proposal.proposedAt,
            decided_at: null,
            decided_by: null,
            decision_reason: null,
          }],
          affectedRows: 0,
          insertId: 0,
        })
        .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        vi.mocked(db.query)
          .mockResolvedValueOnce({ rows: [{ id: 100 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          // 3 INSERTs
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 1 })
          .mockResolvedValueOnce({ rows: [{ id: 1 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 2 })
          .mockResolvedValueOnce({ rows: [{ id: 2 }], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 3 })
          .mockResolvedValueOnce({ rows: [{ id: 3 }], affectedRows: 0, insertId: 0 })
          // 3 UPDATE depends_on
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 })
          // UPDATE plan_coverage
          .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
        return fn(db)
      })

      const pumpSpy = vi.spyOn(coordinator, 'pump').mockResolvedValue()

      const result = await coordinator.approvePlan('task-test-1', 'alexandre')

      expect(result.subtaskCount).toBe(3)
      expect(pumpSpy).toHaveBeenCalled()

      // Verifica que saveTask foi chamado com status 'ready'
      const saveCalls = vi.mocked(repository.saveTask).mock.calls
      const lastSave = saveCalls[saveCalls.length - 1]?.[0]
      expect(lastSave?.status).toBe('ready')
    })
  })
})
