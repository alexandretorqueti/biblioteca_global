/**
 * Baseline + correção herdando escopo (2026-08-31, Alexandre).
 *
 * 1. Correção de gate repetido agora HERDA o escopo da subtarefa original
 *    (o dev da correção não trabalha mais cego).
 * 2. Baseline: primeira subtarefa valida a suíte na branch-base; vermelha →
 *    subtarefa de correção de baseline na mesma posição.
 * 3. Coordenador: correção de baseline devolve a original para pending
 *    (não promove a verified — o trabalho real ainda precisa rodar).
 */

import { describe, it, expect, vi } from 'vitest'
import type { Db, TaskRepository, QueryResult } from '../src/shared/types/infrastructure.js'
import { ResourceLeaseService } from '../src/resources/ResourceLeaseService.js'
import { TaskCoordinator } from '../src/coordinator/TaskCoordinator.js'
import { TaskWorker } from '../src/workers/TaskWorker.js'
import type { SubtaskInfo, WorkerInput } from '../src/shared/types/execution.js'
import { BASELINE_CORRECTION_TITLE, BASELINE_FINGERPRINT_PREFIX, withBaselineExcludes } from '../src/policies/BaselinePolicy.js'

function workerWithRawDb(query: ReturnType<typeof vi.fn>): TaskWorker {
  const worker = new TaskWorker()
  ;(worker as unknown as { db: unknown }).db = { query }
  return worker
}

function callPrivate<T>(worker: TaskWorker, name: string): T {
  return (worker as unknown as Record<string, T>)[name]
}

function createMockDb(): Db {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 } satisfies QueryResult),
    transaction: vi.fn().mockImplementation(async (fn: (db: Db) => Promise<unknown>) => fn(null as never)),
  }
}

describe('exclusões do baseline', () => {
  it('withBaselineExcludes anexa exclusões em comandos vitest e preserva os demais', () => {
    expect(withBaselineExcludes('npm run test')).toBe('npm run test --exclude "**/*.functional.spec.ts"')
    expect(withBaselineExcludes('npx vitest run')).toBe('npx vitest run --exclude "**/*.functional.spec.ts"')
    expect(withBaselineExcludes('make test')).toBe('make test')
  })
})

describe('B8 — corretiva verificada promove a original', () => {
  function coordinatorWithChangedPaths(paths: string[]) {
    const db = createMockDb()
    const repository: TaskRepository = {
      saveTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
    }
    const workspaceManager = { changedPaths: vi.fn().mockResolvedValue(paths) }
    const coordinator = new TaskCoordinator(
      db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 },
      undefined as never, workspaceManager as never,
    )
    return { db, coordinator }
  }

  async function promote(coordinator: TaskCoordinator) {
    const fn = (coordinator as unknown as {
      promoteOriginalAfterTestOnlyCorrection: (subtaskId: number, workspace: { path: string; branch: string; baseCommit: string }, commitSha?: string) => Promise<void>
    }).promoteOriginalAfterTestOnlyCorrection
    await fn.call(coordinator, 733, { path: '/wt', branch: 'b', baseCommit: 'abc12345' }, 'deadbeef123')
  }

  it('corretiva com código + testes → original promovida com nota de escopo entregue', async () => {
    const { db, coordinator } = coordinatorWithChangedPaths([
      'projects/sistema-adm-global/config.json',
      'projects/gerenteagentes/screens/__tests__/NovaTarefaScreen.test.tsx',
    ])
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ correction_for_subtask_id: 729, correction_fingerprint: 'testes falharam: x' }], affectedRows: 0, insertId: 0 })
      .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

    await promote(coordinator)

    const update = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("status = 'verified'"))
    expect(update).toBeDefined()
    expect(String(update?.[1]?.[0])).toContain('Escopo entregue pela subtarefa corretiva 733')
    expect(update?.[1]?.[1]).toBe(729)
  })

  it('corretiva só de testes → original promovida com nota de gate corrigido', async () => {
    const { db, coordinator } = coordinatorWithChangedPaths([
      'projects/gerenteagentes/screens/__tests__/NovaTarefaScreen.test.tsx',
    ])
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ correction_for_subtask_id: 729, correction_fingerprint: 'testes falharam: x' }], affectedRows: 0, insertId: 0 })
      .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })

    await promote(coordinator)

    const update = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("status = 'verified'"))
    expect(update).toBeDefined()
    expect(String(update?.[1]?.[0])).toContain('somente testes alterados')
  })
})

describe('correção de gate herdando escopo original (B1)', () => {

  it('INSERT da correção concatena motivo do gate + escopo original via SQL', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])                    // INSERT gate failure
      .mockResolvedValueOnce([[{ total: 2 }]])                         // COUNT == 2
      .mockResolvedValueOnce([[{ correction_for_subtask_id: null }]])  // não é correção
      .mockResolvedValueOnce([{ affectedRows: 1 }])                    // claim UPDATE
      .mockResolvedValueOnce([{ affectedRows: 0 }])                    // renumeração seq
      .mockResolvedValueOnce([{ affectedRows: 0 }])                    // renumeração seq
      .mockResolvedValueOnce([{ affectedRows: 1 }])                    // INSERT correção
    const worker = workerWithRawDb(query)
    const subtask: SubtaskInfo = {
      id: 729, seq: 1, titulo: 'Estrutura do projeto e config.json',
      scope: 'Criar pasta do projeto e redigir config.json com menus e telas',
      deliverCount: 2,
    }

    const fn = callPrivate<(input: never, subtask: SubtaskInfo, model: string, reason: string) => Promise<boolean>>(worker, 'createCorrectionOnRepeatedGateFailure')
    const created = await fn.call(worker, {} as never, subtask, 'alibaba/qwen3.7-max', 'Testes falharam: timeout no lock')

    expect(created).toBe(true)
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO projeto_640.subtarefas'))
    expect(insert).toBeDefined()
    const sql = String(insert?.[0])
    expect(sql).toContain('CONCAT')
    expect(sql).toContain('Escopo original da subtarefa corrigida:')
    expect(sql).toContain('IFNULL(scope, titulo)')
    // o motivo do gate continua como parâmetro (o escopo original vem da própria linha)
    expect(insert?.[1]).toContain('Corrigir gate repetido: Testes falharam: timeout no lock')
    expect(insert?.[1]).toContain('Correção: Estrutura do projeto e config.json')
  })
})

describe('baseline antes da primeira subtarefa (B4)', () => {
  function makeInput(): WorkerInput {
    return {
      context: { executionId: 'exec-x', taskId: 't1', projectSlug: 'p', phase: 'execute', fencingToken: 1, startedAt: new Date() },
      task: {
        id: 't1', chatId: '', agentId: 'a', title: 'Tarefa', description: '',
        repoPath: '/repo', buildCommand: 'npm run build', unitTestCommand: 'npm run test',
        unitTestExclude: [], baselineMode: 'full', status: 'running', maxRework: 3, hardTimeoutMs: 1000,
      },
      repoPath: '/wt', buildCommand: 'npm run build', testCommand: 'npm run test',
      phase: 'execute',
    } as unknown as WorkerInput
  }

  it('suíte vermelha sem subtarefa verificada → cria correção de baseline e adia a original', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ total: 0 }]])          // COUNT verified == 0
      .mockResolvedValueOnce([{ affectedRows: 3 }])     // seq +10000
      .mockResolvedValueOnce([{ affectedRows: 3 }])     // seq -9999
      .mockResolvedValueOnce([{ affectedRows: 1 }])     // original rejected
      .mockResolvedValueOnce([{ affectedRows: 1 }])     // INSERT correção baseline
    const worker = workerWithRawDb(query)
    const exec = vi.fn().mockImplementation((command: string) => {
      if (command.includes('test')) throw new Error('Testes falharam: suite vermelha')
      return ''
    })
    ;(worker as unknown as { exec: unknown }).exec = exec

    const fn = callPrivate<(input: WorkerInput, subtask: SubtaskInfo) => Promise<string>>(worker, 'runBaselineCheck')
    const subtask: SubtaskInfo = { id: 750, seq: 1, titulo: 'Criar config.json', scope: 'Escopo original completo', deliverCount: 0 }
    const outcome = await fn.call(worker, makeInput(), subtask)

    expect(outcome).toBe('correction_created')
    const rejected = query.mock.calls.find(([sql]) => String(sql).includes("status = 'rejected'"))
    expect(String(rejected?.[1]?.[0])).toContain('Baseline vermelho')
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO projeto_640.subtarefas'))
    const params = insert?.[1] as unknown[]
    // ordem dos parâmetros: [seq, titulo, scope, critério, fingerprint, correction_for]
    expect(params?.[0]).toBe(1)   // assume a posição (seq) da original
    expect(params?.[1]).toBe(BASELINE_CORRECTION_TITLE)
    expect(String(params?.[2])).toContain('suite vermelha')
    expect(String(params?.[2])).toContain('Escopo original completo')
    expect(String(params?.[4])).toMatch(new RegExp('^' + BASELINE_FINGERPRINT_PREFIX))
    expect(String(params?.[4]).length).toBeLessThanOrEqual(500) // coluna varchar(500)
    expect(params?.[5]).toBe(750) // correction_for_subtask_id = original
  })

  it('fingerprint com motivo gigante não estoura o varchar(500)', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const worker = workerWithRawDb(query)
    const exec = vi.fn().mockImplementation((command: string) => {
      if (command.includes('test')) throw new Error('Testes falharam: ' + 'x'.repeat(2000))
      return ''
    })
    ;(worker as unknown as { exec: unknown }).exec = exec

    const fn = callPrivate<(input: WorkerInput, subtask: SubtaskInfo) => Promise<string>>(worker, 'runBaselineCheck')
    await fn.call(worker, makeInput(), { id: 750, seq: 1, titulo: 'x', scope: 's', deliverCount: 0 })

    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO projeto_640.subtarefas'))
    const fp = String((insert?.[1] as unknown[])?.[4])
    expect(fp.startsWith(BASELINE_FINGERPRINT_PREFIX)).toBe(true)
    expect(fp.length).toBeLessThanOrEqual(500)
  })

  it('suíte verde → segue sem criar correção', async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ total: 0 }]])
    const worker = workerWithRawDb(query)
    ;(worker as unknown as { exec: unknown }).exec = vi.fn().mockReturnValue('')

    const fn = callPrivate<(input: WorkerInput, subtask: SubtaskInfo) => Promise<string>>(worker, 'runBaselineCheck')
    const outcome = await fn.call(worker, makeInput(), { id: 750, seq: 1, titulo: 'x', deliverCount: 0 })

    expect(outcome).toBe('ok')
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('tarefa com subtarefa já verificada não roda baseline de novo', async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ total: 2 }]])
    const worker = workerWithRawDb(query)
    const exec = vi.fn()
    ;(worker as unknown as { exec: unknown }).exec = exec

    const fn = callPrivate<(input: WorkerInput, subtask: SubtaskInfo) => Promise<string>>(worker, 'runBaselineCheck')
    const outcome = await fn.call(worker, makeInput(), { id: 750, seq: 3, titulo: 'x', deliverCount: 0 })

    expect(outcome).toBe('ok')
    expect(exec).not.toHaveBeenCalled()
  })

  it('própria correção de baseline pula o baseline (seu gate é a suíte completa)', async () => {
    const query = vi.fn()
    const worker = workerWithRawDb(query)

    const fn = callPrivate<(input: WorkerInput, subtask: SubtaskInfo) => Promise<string>>(worker, 'runBaselineCheck')
    const outcome = await fn.call(worker, makeInput(), {
      id: 751, seq: 1, titulo: BASELINE_CORRECTION_TITLE,
      correctionFingerprint: BASELINE_FINGERPRINT_PREFIX + 'abc', deliverCount: 0,
    })

    expect(outcome).toBe('ok')
    expect(query).not.toHaveBeenCalled()
  })
})

describe('coordenador: correção de baseline devolve a original para pending (não promove)', () => {
  it('fingerprint baseline: → original volta a pending; sem promoção a verified', async () => {
    const db = createMockDb()
    const repository: TaskRepository = {
      saveTask: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
    }
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [{ correction_for_subtask_id: 100, correction_fingerprint: 'baseline:deadbeef' }], affectedRows: 0, insertId: 0 })
      .mockResolvedValueOnce({ rows: [], affectedRows: 1, insertId: 0 })
    const coordinator = new TaskCoordinator(db, repository, new ResourceLeaseService({ db }), { maxWorkers: 1 })

    const fn = (coordinator as unknown as {
      promoteOriginalAfterTestOnlyCorrection: (subtaskId: number, workspace: { path: string; branch: string; baseCommit: string }, commitSha?: string) => Promise<void>
    }).promoteOriginalAfterTestOnlyCorrection
    await fn.call(coordinator, 200, { path: '/wt', branch: 'b', baseCommit: 'abc12345' }, 'deadbeef123')

    const calls = vi.mocked(db.query).mock.calls
    const update = calls.find(([sql]) => String(sql).includes("status = 'pending'"))
    expect(update).toBeDefined()
    expect(update?.[1]).toEqual([200, 100])
    expect(calls.some(([sql]) => String(sql).includes("status = 'verified'"))).toBe(false)
  })
})
