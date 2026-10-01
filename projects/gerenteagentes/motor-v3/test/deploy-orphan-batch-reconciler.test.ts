import { describe, expect, it, vi } from 'vitest'
import { DeployRepository } from '../src/deploy/DeployRepository.js'

function connection() {
  return {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn(),
  }
}

function repository(db: ReturnType<typeof connection>) {
  return new DeployRepository({ getConnection: vi.fn().mockResolvedValue(db) } as never, '/tmp/worktrees')
}

describe('DeployRepository.reconcileOrphanPendingBatches', () => {
  it('não limpa batch pending recente', async () => {
    const db = connection()
    db.query.mockResolvedValueOnce([[], []])

    await expect(repository(db).reconcileOrphanPendingBatches()).resolves.toBe(0)

    expect(db.query).toHaveBeenCalledTimes(1)
    expect(db.query.mock.calls[0][0]).toContain("created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)")
    expect(db.commit).toHaveBeenCalled()
  })

  it('limpa batch pending antigo e devolve seus pedidos a pending', async () => {
    const db = connection()
    db.query
      .mockResolvedValueOnce([[{ batch_id: 'deploy-orphan' }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])

    await expect(repository(db).reconcileOrphanPendingBatches()).resolves.toBe(1)

    expect(db.query.mock.calls[0][0]).toContain("status='pending'")
    expect(db.query.mock.calls[0][0]).toContain('gate_job_id IS NULL')
    expect(db.query.mock.calls[1][0]).toContain("status='failed'")
    expect(db.query.mock.calls[1][0]).toContain('Batch órfão: pending há mais de 30 minutos sem processamento')
    expect(db.query.mock.calls[2][0]).toContain("SET status='pending'")
    expect(db.query.mock.calls[2][0]).toContain('batch_id=NULL')
    expect(db.query.mock.calls[2][1]).toEqual(['deploy-orphan'])
    expect(db.commit).toHaveBeenCalled()
  })

  it('não limpa batch pending antigo que já possui gate_job_id', async () => {
    const db = connection()
    db.query.mockResolvedValueOnce([[], []])

    await expect(repository(db).reconcileOrphanPendingBatches()).resolves.toBe(0)

    expect(db.query).toHaveBeenCalledTimes(1)
    expect(db.query.mock.calls[0][0]).toContain('gate_job_id IS NULL')
    expect(db.commit).toHaveBeenCalled()
  })
})
