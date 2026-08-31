import { describe, expect, it, vi } from 'vitest'
import { ResourceWaitManager } from '../src/resources/ResourceWaitManager.js'
import type { Db, QueryResult, TaskRepository } from '../src/shared/types/infrastructure.js'

function repository(): TaskRepository {
  return { getTask: vi.fn(), saveTask: vi.fn() }
}

describe('ResourceWaitManager', () => {
  it('persiste a espera com o id da fila', async () => {
    const db: Db = {
      query: vi.fn().mockResolvedValue({ rows: [], affectedRows: 1, insertId: 0 } satisfies QueryResult),
      transaction: vi.fn(),
    }
    const manager = new ResourceWaitManager(db, repository())

    await manager.waitForResource('42', 'project:demo:execution', 7, 2)

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('resource_wait_id = ?'), [
      'project:demo:execution', 7, 2, '42',
    ])
  })

  it('usa external_id para tarefas com identificador textual', async () => {
    const db: Db = {
      query: vi.fn().mockResolvedValue({ rows: [], affectedRows: 1, insertId: 0 } satisfies QueryResult),
      transaction: vi.fn(),
    }
    const manager = new ResourceWaitManager(db, repository())

    await manager.waitForResource('task-biblioteca-740', 'project:demo:execution', 7, 2)

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE external_id = ?'), [
      'project:demo:execution', 7, 2, 'task-biblioteca-740',
    ])
  })

  it('cancela a espera usando external_id para tarefas com identificador textual', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], affectedRows: 1, insertId: 0 } satisfies QueryResult)
    const db: Db = { query, transaction: vi.fn() }
    const manager = new ResourceWaitManager(db, repository())

    await manager.cancelWait('task-biblioteca-740')

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('t.external_id = ?'), ['task-biblioteca-740'])
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE external_id = ?'), ['task-biblioteca-740'])
  })

  it('retoma uma tarefa de execucao como ready e consome a entrada da fila', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: '42', resource_wait_id: 7 }], affectedRows: 0, insertId: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], affectedRows: 0, insertId: 0 })
    const db: Db = {
      query,
      transaction: vi.fn().mockImplementation(async (callback: (tx: Db) => Promise<unknown>) => callback(db)),
    }
    const manager = new ResourceWaitManager(db, repository())

    await manager.resumeNext('project:demo:execution')

    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['project:demo:execution'])
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = ?"), ['ready', '42', 7])
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'granted'"), [7])
  })

  it('não concede uma segunda espera quando a transação não encontra fila pendente', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], affectedRows: 0, insertId: 0 })
    const db: Db = {
      query,
      transaction: vi.fn().mockImplementation(async (callback: (tx: Db) => Promise<unknown>) => callback(db)),
    }
    const manager = new ResourceWaitManager(db, repository())

    await manager.resumeNext('project:demo:execution')

    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), ['project:demo:execution'])
  })
})
