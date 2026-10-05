import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls: Array<{ command: string; args: string[] }> = []
let mergeFails = false
let conflictFiles: string[] = []
let isNoopCherryPick = false

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], _options: unknown, callback: Function) => {
    calls.push({ command, args })
    if (command === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--show-toplevel') return callback(null, { stdout: '/repo\n', stderr: '' })
      if (args[1] === 'HEAD') return callback(null, { stdout: 'b'.repeat(40) + '\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'merge-base') {
      if (args[1] === '--is-ancestor') return callback(new Error('not ancestor'), { stdout: '', stderr: '' })
      if (args.includes('HEAD')) return callback(null, { stdout: 'c'.repeat(40) + '\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'worktree') return callback(null, { stdout: '', stderr: '' })
    if (command === 'git' && args[0] === 'merge' && args[1] === '--no-ff' && mergeFails) {
      return callback(new Error('merge conflict'), { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
      return callback(null, { stdout: mergeFails ? conflictFiles.join('\n') + '\n' : '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
      // Para skipNoopCherryPickConflict: retorna true (sem diferença) se for noop
      return callback(isNoopCherryPick ? null : new Error('has changes'), { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'checkout' && args[1] === '--ours') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'add' && args[1] === '--update') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'merge' && args[1] === '--abort') {
      return callback(null, { stdout: '', stderr: '' })
    }
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

describe('DeployConsumer.merge_conflict_classification', () => {
  const commit = 'a'.repeat(40)
  let mockRepository: any
  let mockGate: any
  let mockRemote: any

  beforeEach(() => {
    calls.length = 0
    mergeFails = false
    conflictFiles = []
    isNoopCherryPick = false
    mockRepository = {
      blockBatchForMergeConflict: vi.fn().mockResolvedValue(undefined),
      completeBatch: vi.fn().mockResolvedValue([]),
      releaseDeployLock: vi.fn().mockResolvedValue(undefined),
    }
    mockGate = {}
    mockRemote = {
      assertReady: vi.fn().mockResolvedValue(undefined),
    }
  })

  it('classifica conflito real de merge como merge_conflict com dados estruturados', async () => {
    mergeFails = true
    conflictFiles = ['src/file1.ts', 'src/file2.ts']
    const consumer = new DeployConsumer(mockRepository, mockGate, mockRemote)

    await expect((consumer as any).promote('/repo', 'base-desenvolvimento', commit)).rejects.toMatchObject({
      isMergeConflict: true,
      conflictData: {
        baseBranch: 'base-desenvolvimento',
        taskCommit: commit,
        conflictFiles: ['src/file1.ts', 'src/file2.ts'],
        command: `git merge --no-ff --no-commit ${commit}`,
      },
    })

    // Verificar que merge --abort foi chamado
    expect(calls.some(call => call.args.join(' ') === 'merge --abort')).toBe(true)
  })

  it('inclui todos os arquivos conflitantes no diagnóstico', async () => {
    mergeFails = true
    conflictFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'README.md']
    const consumer = new DeployConsumer(mockRepository, mockGate, mockRemote)

    await expect((consumer as any).promote('/repo', 'base-desenvolvimento', commit)).rejects.toMatchObject({
      conflictData: {
        conflictFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'README.md'],
      },
    })
  })

  it('não classifica falha genérica de deploy como merge_conflict', async () => {
    mergeFails = true
    conflictFiles = [] // Sem arquivos conflitantes
    const consumer = new DeployConsumer(mockRepository, mockGate, mockRemote)

    await expect((consumer as any).promote('/repo', 'base-desenvolvimento', commit)).rejects.toSatisfy((error: any) => {
      return !error.isMergeConflict || error.isMergeConflict === false
    })
  })

  it('detecta cherry-pick noop (alteração simultânea sem conflito real)', async () => {
    // Simular composeBatch com cherry-pick que resulta em noop
    const consumer = new DeployConsumer(mockRepository, mockGate, mockRemote)
    
    // skipNoopCherryPickConflict deve retornar true quando não há mudanças após checkout --ours
    isNoopCherryPick = true
    mergeFails = true
    conflictFiles = ['src/file.ts']

    const result = await (consumer as any).skipNoopCherryPickConflict('/path')
    expect(result).toBe(true)
  })

  it('diferencia conflito real de alteração simultânea sem conflito', async () => {
    const consumer = new DeployConsumer(mockRepository, mockGate, mockRemote)
    
    // Cenário 1: Conflito real (após checkout --ours ainda há mudanças)
    isNoopCherryPick = false
    mergeFails = true
    conflictFiles = ['src/file.ts']
    const result1 = await (consumer as any).skipNoopCherryPickConflict('/path')
    expect(result1).toBe(false) // Não é noop, é conflito real

    // Cenário 2: Alteração simultânea sem conflito (após checkout --ours não há mudanças)
    isNoopCherryPick = true
    const result2 = await (consumer as any).skipNoopCherryPickConflict('/path')
    expect(result2).toBe(true) // É noop, não é conflito real
  })
})

describe('DeployRepository.blockBatchForMergeConflict', () => {
  it('persiste bloqueio com merge_conflict e dados estruturados', async () => {
    const queryMock = vi.fn()
    // Simular UPDATE deploy_batches
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }])
    // Simular UPDATE deploy_requests
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }])
    // Simular SELECT das tarefas do lote
    queryMock.mockResolvedValueOnce([[{ external_id: 'task-p1-1', task_id: 1 }]])
    // Simular INSERT INTO bloqueios
    queryMock.mockResolvedValueOnce([{ insertId: 100 }])
    // Simular INSERT INTO promotion_conflict_analyses
    queryMock.mockResolvedValueOnce([{ insertId: 200 }])
    // Simular INSERT INTO tarefa_chats
    queryMock.mockResolvedValueOnce([{ insertId: 300 }])
    // Simular insertOutbox (não faz query direta, mas precisa de mock para não quebrar)
    
    const mockPool = {
      getConnection: vi.fn().mockReturnValue({
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        query: queryMock,
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
      }),
    }

    const { DeployRepository } = await import('../src/deploy/DeployRepository.js')
    const repo = new DeployRepository(mockPool as any, '/worktrees')

    const conflictData = {
      baseBranch: 'base-desenvolvimento',
      taskBranch: 'motor-v3-work/integration-abc123',
      baseCommit: 'b'.repeat(40),
      taskCommit: 'a'.repeat(40),
      mergeBaseCommit: 'c'.repeat(40),
      conflictFiles: ['src/file1.ts', 'src/file2.ts'],
      command: 'git merge --no-ff --no-commit abc123',
    }

    const source = {
      messageId: 'msg-1',
      executionId: 'exec-1',
      correlationId: 'corr-1',
      taskId: 'task-1',
      type: 'DEPLOY_BATCH_DISPATCH_REQUESTED',
      payload: {},
    }

    await repo.blockBatchForMergeConflict('batch-1', conflictData, source as any)

    const connection = mockPool.getConnection()
    
    // Verificar que beginTransaction foi chamado
    expect(connection.beginTransaction).toHaveBeenCalled()


    // Verificar que INSERT INTO bloqueios foi chamado com merge_conflict
    const bloqueioCall = queryMock.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO bloqueios') && call[0].includes('merge_conflict')
    )
    expect(bloqueioCall).toBeTruthy()

    // Verificar que INSERT INTO promotion_conflict_analyses foi chamado
    const conflictAnalysisCall = queryMock.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO promotion_conflict_analyses')
    )
    expect(conflictAnalysisCall).toBeTruthy()

    // Verificar que INSERT INTO tarefa_chats foi chamado
    const chatCall = queryMock.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('INSERT INTO tarefa_chats')
    )
    expect(chatCall).toBeTruthy()

    // Verificar que commit foi chamado
    expect(connection.commit).toHaveBeenCalled()
  })
})
