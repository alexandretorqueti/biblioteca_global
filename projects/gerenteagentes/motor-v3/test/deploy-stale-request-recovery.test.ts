// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import { DeployRepository, type DeployTaskContext } from '../src/deploy/DeployRepository.js'
import { createQueueMessage } from '../src/queue/index.js'

function connection(results: unknown[]) {
  return {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
    query: vi.fn(async () => [results.shift() ?? [], []]),
  }
}

const context: DeployTaskContext = {
  taskId: '815', databaseTaskId: 815, projectId: 1, repoPath: '/repo', baseBranch: 'base',
  buildCommand: 'npm run build', testCommand: 'npm test', integrationPath: '/worktree',
  integrationBranch: 'integration-815', integrationCommit: 'deadbeef',
}

describe('proteção contra recovery de deploy obsoleto', () => {
  it.each(['failed', 'succeeded', 'cancelled'] as const)('acceptRequest preserva request %s sem reenfileirar', async status => {
    const db = connection([
      [{ id: 815, tipo: 'desenvolvimento', integration_confirmed_at: new Date(), terminal_status: 'completed', blocked: 0 }],
      { insertId: 257 },
      [{ status }],
    ])
    const repository = new DeployRepository({ getConnection: vi.fn().mockResolvedValue(db) } as never, '/tmp/worktrees')
    const message = createQueueMessage({ type: 'DEPLOY_REQUESTED', taskId: '815', executionId: 'recovery-815' })

    await expect(repository.acceptRequest(context, message)).resolves.toEqual({ requestId: 257, accepted: false })
    expect(db.query.mock.calls.some(call => String(call[0]).includes('DEPLOY_REQUEST_ACCEPTED'))).toBe(false)
    expect(db.commit).toHaveBeenCalled()
  })

  it('boot recovery não recria request quando já existe registro final', async () => {
    const db = connection([[]])
    const repository = new DeployRepository({ getConnection: vi.fn().mockResolvedValue(db) } as never, '/tmp/worktrees')

    await expect(repository.enqueueCompletedRecoveries()).resolves.toBe(0)
    const sql = String(db.query.mock.calls[0]?.[0])
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM deploy_requests d WHERE d.tarefa_id=t.id)')
  })

  it('mensagem antiga não prepara Git quando já há request persistido', async () => {
    const raw = { ...context }
    delete (raw as Partial<DeployTaskContext>).integrationPath
    delete (raw as Partial<DeployTaskContext>).integrationBranch
    delete (raw as Partial<DeployTaskContext>).integrationCommit
    const repository = {
      getEligibleTask: vi.fn(async () => raw),
      needsRequestPreparation: vi.fn(async () => false),
    } as never
    const logger = { append: vi.fn(async () => {}) }
    const consumer = new DeployConsumer(repository, {} as never, {} as never, logger)
    const message = createQueueMessage({ type: 'DEPLOY_REQUESTED', taskId: '911', executionId: 'old-preparation' })

    await expect(consumer.handle(message)).resolves.toBeUndefined()
    expect(repository.needsRequestPreparation).toHaveBeenCalledWith(815)
    expect(logger.append).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'skipped', reasonCode: 'deploy_request_already_persisted' }))
  })
})
