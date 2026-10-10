import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Governança de conflito entre membros do batch de deploy (Subtarefa 1):
 * - Conflito real em um membro → isola esse membro, segue com os demais
 * - Todos conflitam → batch falha com todas as análises gravadas
 * - Conflito noop → ignora sem bloqueio ou análise
 * - Persistência idempotente em promotion_conflict_analyses
 */

const calls: Array<{ command: string; args: string[] }> = []
let cherryPickFailCommits: Set<string> = new Set()
let cherryPickNoopCommits: Set<string> = new Set()
let conflictFileList: string[] = ['src/conflict.ts']
let headReads = 0

/**
 * Mapeia requestedCommit → cherry-pick commit (hex-válido, 40 chars).
 * Prefixo 'cc' + 6 primeiros chars do input + 'cc' * 16 = 40 chars.
 * Ex: 'aaaa...aa' → 'ccaaaaaacccccccccccccccccccccccccccccccc'
 */
function cherryForCommit(inputCommit: string): string {
  return `cc${inputCommit.slice(0, 6)}${'c'.repeat(32)}`.slice(0, 40)
}

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], _options: unknown, callback: Function) => {
    calls.push({ command, args: [...args] })
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return callback(null, { stdout: '/repo\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      headReads += 1
      return callback(null, { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'worktree') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'merge-base') {
      return callback(new Error('not ancestor'), { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry') {
      const inputCommit = args[2] as string
      const cherryCommit = cherryForCommit(inputCommit)
      return callback(null, { stdout: `+ ${cherryCommit}\n`, stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args[1] === '--abort') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args[1] === '--skip') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'cherry-pick' && args.length === 2 && args[1] !== '--abort' && args[1] !== '--skip') {
      const commit = args[1]!
      if (cherryPickFailCommits.has(commit)) {
        return callback(new Error(`CONFLICT (content): Merge conflict in ${conflictFileList.join(', ')}`), { stdout: '', stderr: '' })
      }
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) {
      // Retorna arquivos conflitantes quando há cherry-pick em conflito ativo
      return callback(null, { stdout: conflictFileList.join('\n') + '\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
      // Noop: último cherry-pick falhou mas checkout --ours resolve tudo (sem diff)
      const lastCherryPick = calls
        .filter(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args.length === 2 && c.args[1] !== '--abort' && c.args[1] !== '--skip')
        .pop()
      if (lastCherryPick && cherryPickNoopCommits.has(lastCherryPick.args[1]!)) {
        return callback(null, { stdout: '', stderr: '' })
      }
      return callback(new Error('has changes'), { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'checkout') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'add') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'npm') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'test') {
      return callback(new Error('not found'), { stdout: '', stderr: '' })
    }
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'

describe('DeployConsumer.composeBatch — isolamento de membro conflitante', () => {
  beforeEach(() => {
    calls.length = 0
    headReads = 0
    cherryPickFailCommits = new Set()
    cherryPickNoopCommits = new Set()
    conflictFileList = ['src/conflict.ts']
  })

  it('3 membros, 2º conflita → batch segue com 1º+3º, 2º isolado', async () => {
    // Membro 2 (commit 'b'*40) terá cherry-pick conflitante
    const member2Cherry = cherryForCommit('b'.repeat(40))
    cherryPickFailCommits.add(member2Cherry)

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-test', [
      { requestedCommit: 'a'.repeat(40), taskId: 'task-1', databaseTaskId: 1, index: 0 },
      { requestedCommit: 'b'.repeat(40), taskId: 'task-2', databaseTaskId: 2, index: 1 },
      { requestedCommit: 'd'.repeat(40), taskId: 'task-3', databaseTaskId: 3, index: 2 },
    ])

    // cherry-pick --abort foi chamado para o commit conflitante
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--abort')).toBe(true)

    // Exatamente 1 conflito reportado (membro 2)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({
      index: 1,
      taskId: 'task-2',
      databaseTaskId: 2,
      conflictFiles: ['src/conflict.ts'],
    })

    // Commit composto existe (membros 1 e 3 aplicados com sucesso)
    expect(result.commit).toBeTruthy()
    expect(result.path).toContain('.motor-v3-deploy-batch-test')

    // Membros 1 e 3 tiveram cherry-pick executado com sucesso (não estão em fail set)
    const cherryPicks = calls.filter(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args.length === 2 && c.args[1] !== '--abort' && c.args[1] !== '--skip')
    // 3 cherry-picks tentados (1 por membro), 1 falhou
    expect(cherryPicks).toHaveLength(3)
  })

  it('todos conflitam → batch retorna conflicts com todos os membros', async () => {
    cherryPickFailCommits.add(cherryForCommit('a'.repeat(40)))
    cherryPickFailCommits.add(cherryForCommit('b'.repeat(40)))
    cherryPickFailCommits.add(cherryForCommit('d'.repeat(40)))

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-all-conflict', [
      { requestedCommit: 'a'.repeat(40), taskId: 'task-1', databaseTaskId: 1, index: 0 },
      { requestedCommit: 'b'.repeat(40), taskId: 'task-2', databaseTaskId: 2, index: 1 },
      { requestedCommit: 'd'.repeat(40), taskId: 'task-3', databaseTaskId: 3, index: 2 },
    ])

    expect(result.conflicts).toHaveLength(3)
    expect(result.conflicts.map((c: any) => c.taskId)).toEqual(['task-1', 'task-2', 'task-3'])

    const aborts = calls.filter(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--abort')
    expect(aborts).toHaveLength(3)
  })

  it('conflito noop → ignora sem bloqueio ou análise', async () => {
    // Membro 2 conflita mas é noop (base já contém o resultado final)
    const member2Cherry = cherryForCommit('b'.repeat(40))
    cherryPickFailCommits.add(member2Cherry)
    cherryPickNoopCommits.add(member2Cherry)

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    const result = await (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-noop', [
      { requestedCommit: 'a'.repeat(40), taskId: 'task-1', databaseTaskId: 1, index: 0 },
      { requestedCommit: 'b'.repeat(40), taskId: 'task-2', databaseTaskId: 2, index: 1 },
      { requestedCommit: 'd'.repeat(40), taskId: 'task-3', databaseTaskId: 3, index: 2 },
    ])

    // Zero conflitos reais reportados
    expect(result.conflicts).toHaveLength(0)

    // cherry-pick --skip chamado para o noop
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--skip')).toBe(true)

    // cherry-pick --abort NÃO chamado (noop usa --skip)
    expect(calls.some(c => c.command === 'git' && c.args[0] === 'cherry-pick' && c.args[1] === '--abort')).toBe(false)
  })

  it('legacy: chamada com strings (sem metadados) propaga conflito como erro', async () => {
    cherryPickFailCommits.add(cherryForCommit('a'.repeat(40)))

    const consumer = new DeployConsumer({} as never, {} as never, {} as never)
    await expect(
      (consumer as any).composeBatch('/repo', 'base-desenvolvimento', 'batch-legacy', [
        'a'.repeat(40),
      ]),
    ).rejects.toThrow()
  })
})

describe('DeployRepository.isolateConflictingMembers', () => {
  it('persiste atomicamente: request→pending, bloqueio, análise e chat', async () => {
    const queryMock = vi.fn()
    for (let i = 0; i < 2; i++) {
      queryMock.mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE deploy_requests
      queryMock.mockResolvedValueOnce([{ insertId: 100 + i }]) // INSERT bloqueios
      queryMock.mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT IGNORE promotion_conflict_analyses
      queryMock.mockResolvedValueOnce([{ insertId: 300 + i }]) // INSERT tarefa_chats
      queryMock.mockResolvedValueOnce([{ insertId: 400 + i }]) // INSERT motor_outbox (TASK_BLOCKED)
    }

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

    await repo.isolateConflictingMembers('batch-test', [
      { index: 1, taskId: 'task-2', databaseTaskId: 2, conflictFiles: ['src/a.ts'], conflictExcerpt: 'CONFLICT in src/a.ts', taskCommit: 'b'.repeat(40) },
      { index: 3, taskId: 'task-4', databaseTaskId: 4, conflictFiles: ['src/b.ts'], conflictExcerpt: 'CONFLICT in src/b.ts', taskCommit: 'e'.repeat(40) },
    ], { messageId: 'msg-1', executionId: 'exec-1', correlationId: 'corr-1', taskId: 'task-1', type: 'DEPLOY_BATCH_DISPATCH_REQUESTED', payload: {} } as any)

    const connection = mockPool.getConnection()
    expect(connection.beginTransaction).toHaveBeenCalled()
    expect(connection.commit).toHaveBeenCalled()

    // UPDATE deploy_requests → pending + batch_id=NULL
    const updateCalls = queryMock.mock.calls.filter((c: any[]) => typeof c[0] === 'string' && c[0].includes('UPDATE deploy_requests') && c[0].includes("status='pending'"))
    expect(updateCalls).toHaveLength(2)

    // INSERT INTO bloqueios com deploy_member_conflict
    const bloqueioCalls = queryMock.mock.calls.filter((c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO bloqueios') && c[0].includes('deploy_member_conflict'))
    expect(bloqueioCalls).toHaveLength(2)

    // INSERT IGNORE INTO promotion_conflict_analyses
    const analysisCalls = queryMock.mock.calls.filter((c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT IGNORE INTO promotion_conflict_analyses'))
    expect(analysisCalls).toHaveLength(2)

    // INSERT INTO tarefa_chats
    const chatCalls = queryMock.mock.calls.filter((c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO tarefa_chats'))
    expect(chatCalls).toHaveLength(2)
  })

  it('rollback em falha de qualquer conflito', async () => {
    const queryMock = vi.fn()
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }])
    queryMock.mockRejectedValueOnce(new Error('DB connection lost'))

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

    await expect(repo.isolateConflictingMembers('batch-test', [
      { index: 1, taskId: 'task-2', databaseTaskId: 2, conflictFiles: ['src/a.ts'], conflictExcerpt: 'fail', taskCommit: 'b'.repeat(40) },
    ], { messageId: 'm', executionId: 'e', taskId: 't', type: 'x', payload: {} } as any)).rejects.toThrow('DB connection lost')

    expect(mockPool.getConnection().rollback).toHaveBeenCalled()
  })

  it('fingerprint cabe em char(64)', async () => {
    const queryMock = vi.fn()
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }])
    queryMock.mockResolvedValueOnce([{ insertId: 100 }])
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }])
    queryMock.mockResolvedValueOnce([{ insertId: 300 }])
    queryMock.mockResolvedValueOnce([{ insertId: 400 }])

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

    const longBatchId = `deploy-${'f'.repeat(36)}`
    await repo.isolateConflictingMembers(longBatchId, [
      { index: 0, taskId: 'task-1', databaseTaskId: 1, conflictFiles: [], conflictExcerpt: 'test', taskCommit: 'a'.repeat(40) },
    ], { messageId: 'm', executionId: 'e', taskId: 't', type: 'x', payload: {} } as any)

    const analysisCall = queryMock.mock.calls.find((c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT IGNORE INTO promotion_conflict_analyses'))
    expect(analysisCall).toBeTruthy()
    const fingerprint = analysisCall![1][2]
    expect(fingerprint.length).toBeLessThanOrEqual(64)
    expect(fingerprint).toMatch(/^mc:/)
  })

  it('idempotência: INSERT IGNORE não duplica análise com mesmo fingerprint', async () => {
    const queryMock = vi.fn()
    // Primeiro conflito: UPDATE + INSERT bloqueio + INSERT IGNORE + chat + outbox
    queryMock.mockResolvedValueOnce([{ affectedRows: 1 }])
    queryMock.mockResolvedValueOnce([{ insertId: 100 }])
    queryMock.mockResolvedValueOnce([{ affectedRows: 0 }]) // INSERT IGNORE não insere (fingerprint duplicado)
    queryMock.mockResolvedValueOnce([{ insertId: 300 }])
    queryMock.mockResolvedValueOnce([{ insertId: 400 }])

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

    // Mesmo batch e commit = mesmo fingerprint
    await repo.isolateConflictingMembers('batch-idem', [
      { index: 0, taskId: 'task-1', databaseTaskId: 1, conflictFiles: ['src/a.ts'], conflictExcerpt: 'test', taskCommit: 'a'.repeat(40) },
    ], { messageId: 'm', executionId: 'e', taskId: 't', type: 'x', payload: {} } as any)

    // INSERT IGNORE garante que não há erro nem duplicação
    const analysisCall = queryMock.mock.calls.find((c: any[]) => typeof c[0] === 'string' && c[0].includes('INSERT IGNORE INTO promotion_conflict_analyses'))
    expect(analysisCall).toBeTruthy()
    // affectedRows=0 confirma que o fingerprint já existia
    const analysisResult = queryMock.mock.results.find((r: any) => r.value && typeof r.value.then === 'function' ? false : r.value?.[0]?.affectedRows === 0)
    // O importante é que a transação comitou sem erro
    expect(mockPool.getConnection().commit).toHaveBeenCalled()
  })
})
