import { describe, expect, it, vi } from 'vitest'
import { DeployRepository } from '../src/deploy/DeployRepository.js'

describe('DeployRepository.integrationBranchesAwaitingBaseSync', () => {
  it('seleciona somente os estados interrompidos na mesma base do lote', async () => {
    const query = vi.fn(async () => [[
      { id: 12, external_id: 'task-p2-12', repo_path: '/repo', base_branch: 'base-desenvolvimento' },
    ]])
    const pool = { query } as never
    const repository = new DeployRepository(pool, '/worktrees')

    await expect(repository.integrationBranchesAwaitingBaseSync('batch-1')).resolves.toEqual([
      { taskId: 'task-p2-12', repoPath: '/repo', baseBranch: 'base-desenvolvimento' },
    ])

    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('t.paused_at IS NOT NULL')
    expect(sql).toContain('clarification_pending_at IS NOT NULL')
    expect(sql).toContain("cix.estado='awaiting_human'")
    expect(sql).toContain("s.status='blocked'")
    expect(sql).toContain('pmc.repo_path=b.repo_path')
    expect(sql).toContain('pmc.branch_trabalho=b.base_branch')
  })
})
