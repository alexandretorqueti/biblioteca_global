/**
 * Testes das três lacunas fechadas em 2026-08-30:
 * 1. saveTask grava erro em ultima_mensagem_erro (nunca em descricao)
 * 2. falha de integração persiste linha em bloqueios
 * 3. GET task retorna subtarefas junto com a tarefa
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Db, TaskRepository, QueryResult } from '../src/shared/types/infrastructure.js'
import { MysqlTaskRepository } from '../src/database/DrizzleDb.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'
import { WorkerLauncher } from '../src/workers/WorkerLauncher.js'

function createMockDb(): Db {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn(null as never)),
  }
}

describe('lacuna 1 — erro não sobrescreve a descrição da tarefa', () => {
  let db: Db
  let repository: MysqlTaskRepository

  beforeEach(() => {
    db = createMockDb()
    repository = new MysqlTaskRepository(db)
  })

  it('grava errorMessage em ultima_mensagem_erro e preserva descricao', async () => {
    // SELECT do getTask interno: tarefa já existe
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{
        id: 9, external_id: 'task-9', titulo: 'Título original', descricao: 'Descrição original',
        status: 'running', max_rework: 3, hard_timeout_ms: 3600000,
        created_at: '', updated_at: '',
      }],
      affectedRows: 0, insertId: 0,
    })

    await repository.saveTask({
      id: 'task-9', chatId: '', agentId: '', title: 'Título original', description: 'Descrição original',
      repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
      status: 'blocked', maxRework: 3, hardTimeoutMs: 3600000,
      errorMessage: '[gate] testes falharam',
    })

    const updateCall = vi.mocked(db.query).mock.calls[1]
    const sql = String(updateCall?.[0])
    expect(sql).toContain('ultima_mensagem_erro = ?')
    expect(sql).not.toContain('descricao = ?')
    expect(updateCall?.[1]).toContain('[gate] testes falharam')
    expect(updateCall?.[1]).toContain('blocked')
    expect(updateCall?.[1]).not.toContain('Descrição original')
  })

  it('leitura devolve errorMessage sem confundir com a descrição', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{
        id: 9, external_id: 'task-9', titulo: 'Título original', descricao: 'Descrição original',
        ultima_mensagem_erro: 'erro antigo', status: 'blocked',
        max_rework: 3, hard_timeout_ms: 3600000, created_at: '', updated_at: '',
      }],
      affectedRows: 0, insertId: 0,
    })

    const task = await repository.getTask('task-9')

    expect(task?.description).toBe('Descrição original')
    expect(task?.errorMessage).toBe('erro antigo')
  })
})

describe('lacuna 2 — falha de integração persiste bloqueio', () => {
  it('registra bloqueios com evidência quando o merge falha', async () => {
    const db = createMockDb()
    const repository: TaskRepository = {
      saveTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue({
        id: 'task-int', chatId: '', agentId: 'agent', title: 'Integra', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'running', maxRework: 1, hardTimeoutMs: 1000, projectSlug: null,
      }),
    }
    const failingWorkspace = {
      integrate: vi.fn().mockRejectedValue(new Error('conflito no merge')),
      cleanup: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn(),
      changedPaths: vi.fn().mockResolvedValue([]),
    } as never
    const coordinator = new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 }, new WorkerLauncher(), failingWorkspace)
    const internal = coordinator as unknown as {
      activeWorkers: Map<string, {
        taskId: string; executionId: string; resourceKey: null; fencingToken: number
        startedAt: Date; phase: 'execute'; subtaskId: number; repoPath: string
        baseBranch: string; workspace: { path: string; branch: string; baseCommit: string }
      }>
    }
    internal.activeWorkers.set('exec-int', {
      taskId: 'task-int', executionId: 'exec-int', resourceKey: null, fencingToken: 0,
      startedAt: new Date(), phase: 'execute', subtaskId: 55, repoPath: '/repo',
      baseBranch: 'main', workspace: { path: '/tmp/ws', branch: 'motor-v2/x/55/a1', baseCommit: 'abc1234' },
    })

    await coordinator.onTaskCompleted('exec-int', { gitCommitSha: 'deadbeef77' } as never)

    const calls = vi.mocked(db.query).mock.calls
    const bloqueioInsert = calls.find(([sql]) => String(sql).includes('INSERT INTO bloqueios'))
    expect(bloqueioInsert).toBeDefined()
    expect(bloqueioInsert?.[1]).toContain('systemic_failure')
    expect(String(bloqueioInsert?.[1]?.[3])).toContain('conflito no merge')

    const workspaceUpdate = calls.find(([sql]) => String(sql).includes("workspace_status = 'integration_failed'"))
    expect(workspaceUpdate).toBeDefined()
    expect(repository.saveTask).toHaveBeenCalledWith(expect.objectContaining({
      status: 'blocked',
      errorMessage: expect.stringContaining('conflito no merge'),
    }))
  })
})

describe('lacuna 3 — tarefa vem com subtarefas na resposta', () => {
  it('GET task monta tarefa + subtarefas ordenadas', async () => {
    const db = createMockDb()
    const repository: TaskRepository = {
      saveTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue({
        id: '727', chatId: '', agentId: 'agent', title: 'Com plano', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'running', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'p',
      }),
    }
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        { id: 11, seq: 1, titulo: 'Primeira', status: 'verified', resultado: null, deliver_count: 0, workspace_status: 'integrated', workspace_branch: 'motor-v2/727/11/a1', workspace_commit_sha: 'abc1234', correction_for_subtask_id: null },
        { id: 12, seq: 2, titulo: 'Segunda', status: 'running', resultado: 'parcial', deliver_count: 1, workspace_status: 'active', workspace_branch: null, workspace_commit_sha: null, correction_for_subtask_id: 11 },
      ],
      affectedRows: 0, insertId: 0,
    })
    const coordinator = new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 })

    const detail = await coordinator.getTaskWithSubtasks('727')

    expect(detail?.id).toBe('727')
    expect(detail?.subtasks).toHaveLength(2)
    expect(detail?.subtasks[0]).toMatchObject({
      id: 11, seq: 1, titulo: 'Primeira', status: 'verified', workspaceStatus: 'integrated',
      correctionForSubtaskId: null,
    })
    expect(detail?.subtasks[1]).toMatchObject({
      id: 12, seq: 2, status: 'running', resultado: 'parcial', deliverCount: 1,
      correctionForSubtaskId: 11,
    })
    const querySql = String(vi.mocked(db.query).mock.calls[0]?.[0])
    expect(querySql).toContain('ORDER BY s.seq ASC')
    expect(querySql).toContain('WHERE (t.external_id = ? OR t.id = ?)')
  })

  it('tarefa inexistente continua retornando null', async () => {
    const db = createMockDb()
    const repository: TaskRepository = {
      saveTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
    }
    const coordinator = new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 })

    expect(await coordinator.getTaskWithSubtasks('inexistente')).toBeNull()
  })
})
