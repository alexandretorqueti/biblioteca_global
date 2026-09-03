/**
 * Correção que falha bloqueia a tarefa inteira (2026-08-30, Alexandre):
 * - correção com 2ª falha idêntica NÃO gera outra correção — bloqueia tudo;
 * - subtarefa original mantém o comportamento de criar a correção;
 * - GET task expõe errorMessage + ultimoBloqueio para a tela de acompanhamento.
 */

import { describe, it, expect, vi } from 'vitest'
import type { Db, TaskRepository, QueryResult } from '../src/shared/types/infrastructure.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'
import { TaskWorker } from '../src/workers/TaskWorker.js'
import type { SubtaskInfo } from '../src/shared/types/execution.js'

function createMockDb(): Db {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn(null as never)),
  }
}

function workerWithRawDb(query: ReturnType<typeof vi.fn>): TaskWorker {
  const worker = new TaskWorker()
  // O worker usa conexão mysql2 crua: query retorna tupla [rows], não o wrapper Db.
  ;(worker as unknown as { db: unknown }).db = { query }
  return worker
}

async function callCorrectionGate(
  worker: TaskWorker,
  subtask: SubtaskInfo,
  reason: string,
): Promise<boolean> {
  const fn = (worker as unknown as {
    createCorrectionOnRepeatedGateFailure: (
      input: never, subtask: SubtaskInfo, model: string, reason: string,
    ) => Promise<boolean>
  }).createCorrectionOnRepeatedGateFailure
  return fn.call(worker, {} as never, subtask, 'alibaba/qwen3.7-max', reason)
}

describe('correção que falha repetidamente bloqueia a tarefa inteira', () => {
  it('não cria correção da correção — persiste bloqueio correction_failed e lança erro', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])                  // INSERT gate failure
      .mockResolvedValueOnce([[{ total: 2 }]])                       // COUNT == 2
      .mockResolvedValueOnce([[{ correction_for_subtask_id: 721 }]]) // é correção
      .mockResolvedValueOnce([{ affectedRows: 1 }])                  // INSERT bloqueios
    const worker = workerWithRawDb(query)
    const subtask: SubtaskInfo = { id: 728, seq: 3, titulo: 'Correção: Correção: arrumar README', deliverCount: 2 }

    await expect(callCorrectionGate(worker, subtask, 'Testes falharam: Command failed: false'))
      .rejects.toThrow(/Subtarefa de correção 728 falhou repetidamente/)

    const calls = query.mock.calls.map(([sql]) => String(sql))
    expect(calls.some((sql) => sql.includes('INSERT INTO bloqueios'))).toBe(true)
    // Verifica que NÃO criou nova subtarefa de correção (mas pode ter gravado histórico em subtarefas_entregas)
    expect(calls.some((sql) => sql.includes('INSERT INTO subtarefas ') && !sql.includes('subtarefas_entregas'))).toBe(false)
    const bloqueioParams = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO bloqueios'))?.[1]
    expect(bloqueioParams).toContain('correction_failed')
    expect(String(bloqueioParams?.[3])).toContain('corrige a subtarefa 721')
  })

  it('subtarefa original (não-correção) continua gerando correção normalmente', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])               // INSERT gate failure
      .mockResolvedValueOnce([[{ total: 2 }]])                    // COUNT == 2
      .mockResolvedValueOnce([[{ correction_for_subtask_id: null }]]) // não é correção
      .mockResolvedValueOnce([{ affectedRows: 1 }])               // claim UPDATE
      .mockResolvedValueOnce([{ affectedRows: 0 }])               // renumeração seq
      .mockResolvedValueOnce([{ affectedRows: 0 }])               // renumeração seq
      .mockResolvedValueOnce([{ affectedRows: 1 }])               // INSERT correção
    const worker = workerWithRawDb(query)
    const subtask: SubtaskInfo = { id: 721, seq: 1, titulo: 'Arrumar README', deliverCount: 2 }

    const created = await callCorrectionGate(worker, subtask, 'Testes falharam: Command failed: false')

    expect(created).toBe(true)
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO subtarefas'))
    expect(insert).toBeDefined()
    expect(insert?.[1]).toContain('Correção: Arrumar README')
  })

  it('falha única (count 1) não bloqueia nem cria correção', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ total: 1 }]])
    const worker = workerWithRawDb(query)
    const subtask: SubtaskInfo = { id: 900, seq: 1, titulo: 'Qualquer', deliverCount: 1 }

    const created = await callCorrectionGate(worker, subtask, 'erro qualquer')

    expect(created).toBe(false)
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe('detalhe da tarefa expõe errorMessage e ultimoBloqueio', () => {
  it('GET task traz o bloqueio mais recente para a tela', async () => {
    const db = createMockDb()
    const repository: TaskRepository = {
      saveTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue({
        id: '729', chatId: '', agentId: 'agent', title: 'Gate repetido', description: 'descrição original',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'blocked', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'p',
        errorMessage: 'Subtarefa de correção 728 falhou repetidamente',
      }),
    }
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [], affectedRows: 0, insertId: 0 }) // subtarefas vazias
      .mockResolvedValueOnce({
        rows: [{
          block_reason: 'correction_failed',
          block_excerpt: 'Subtarefa de correção 728 falhou repetidamente (corrige a subtarefa 721)',
          blocked_at: '2026-08-30T20:40:00.000Z',
          subtarefa_id: 728,
        }],
        affectedRows: 0, insertId: 0,
      })
    const coordinator = new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 })

    const detail = await coordinator.getTaskWithSubtasks('729')

    expect(detail?.status).toBe('blocked')
    expect(detail?.errorMessage).toBe('Subtarefa de correção 728 falhou repetidamente')
    expect(detail?.ultimoBloqueio).toMatchObject({
      kind: 'correction_failed',
      subtaskId: 728,
    })
    expect(detail?.ultimoBloqueio?.excerpt).toContain('corrige a subtarefa 721')
  })

  it('tarefa sem bloqueios retorna ultimoBloqueio null', async () => {
    const db = createMockDb()
    const repository: TaskRepository = {
      saveTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue({
        id: '730', chatId: '', agentId: 'agent', title: 'Sem bloqueio', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'running', maxRework: 3, hardTimeoutMs: 1000, projectSlug: null,
      }),
    }
    const coordinator = new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 })

    const detail = await coordinator.getTaskWithSubtasks('730')

    expect(detail?.ultimoBloqueio).toBeNull()
    expect(detail?.errorMessage).toBeUndefined()
  })

  it('B9: bloqueio histórico não vaza para tarefa já retomada', async () => {
    const db = createMockDb()
    const repository: TaskRepository = {
      saveTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue({
        id: '731', chatId: '', agentId: 'agent', title: 'Retomada', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        status: 'running', maxRework: 3, hardTimeoutMs: 1000, projectSlug: 'p',
      }),
    }
    const coordinator = new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 })

    const detail = await coordinator.getTaskWithSubtasks('731')

    expect(detail?.ultimoBloqueio).toBeNull()
    const calls = vi.mocked(db.query).mock.calls
    expect(calls.some(([sql]) => String(sql).includes('bloqueios'))).toBe(false)
  })
})
