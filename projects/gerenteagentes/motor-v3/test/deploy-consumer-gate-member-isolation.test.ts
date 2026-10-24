import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Isolamento de membros culpados quando o gate pre_deploy do commit composto
 * falha (incidente 2026-10-23: 13 tarefas bloqueadas porque 1 membro do batch
 * tinha migration quebrada / erro de compilação).
 *
 * Regra: com evidência inequívoca (caminhos de falha ↔ arquivos do membro),
 * isola somente os culpados e devolve os inocentes à fila. Sem evidência,
 * membro único ou todos culpados → comportamento histórico (batch inteiro
 * bloqueia), mas com razão enriquecida (exit code + cauda da saída).
 */

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
}))

const gitResponses: {
  mergeBase: Record<string, string>
  diffFiles: Record<string, string>
} = { mergeBase: {}, diffFiles: {} }

vi.mock('node:child_process', () => ({
  execFile: vi.fn((command: string, args: string[], _options: unknown, callback: Function) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return callback(null, { stdout: '/repo\n', stderr: '' })
    }
    if (command === 'git' && args[0] === 'worktree') {
      return callback(null, { stdout: '', stderr: '' })
    }
    if (command === 'git' && args[0] === 'merge-base') {
      const commit = args[2] as string
      return callback(null, { stdout: `${gitResponses.mergeBase[commit] ?? 'f'.repeat(40)}\n`, stderr: '' })
    }
    if (command === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
      const range = args[2] as string
      const commit = range.split('..')[1] ?? ''
      return callback(null, { stdout: `${gitResponses.diffFiles[commit] ?? ''}\n`, stderr: '' })
    }
    return callback(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import { createQueueMessage } from '../src/queue/index.js'

const BATCH = {
  batchId: 'deploy-test-1',
  repoPath: '/repo',
  baseBranch: 'base-desenvolvimento',
  expectedCommit: 'c'.repeat(40),
  status: 'pending' as const,
  remotePid: null,
  remoteStatusPath: null,
  startedAt: null,
  workspacePath: '/repo/.motor-v3-deploy-test-1',
  gateJobId: 975,
}

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

const TSC_EVIDENCE = {
  exitCode: 2,
  status: 'failed',
  stdout: '\nadded 83 packages in 3s\nsrc/start.ts(645,11): error TS2304: Cannot find name \'ConsoleHumanNotifier\'.\n',
  stderr: '',
  buildCommand: 'cd projects/gerenteagentes/motor-v3 && npm ci --prefer-offline --no-audit --no-fund && npm run build',
  testCommand: 'cd projects/gerenteagentes/motor-v3 && npx vitest run',
  sourceFiles: [] as string[],
}

function buildHarness(overrides: {
  evidence?: typeof TSC_EVIDENCE | null
  members?: Array<{ databaseTaskId: number; taskId: string; requestedCommit: string }>
  batch?: typeof BATCH | null
} = {}) {
  const repository = {
    continueAfterPreDeployGate: vi.fn(async () => ({ accepted: true })),
    enqueuePendingDispatches: vi.fn(async () => 0),
    findPendingBatchByGateJob: vi.fn(async () => (overrides.batch === undefined ? BATCH : overrides.batch)),
    loadGateFailureEvidence: vi.fn(async () => (overrides.evidence === undefined ? TSC_EVIDENCE : overrides.evidence)),
    batchMembers: vi.fn(async () => overrides.members ?? [
      { databaseTaskId: 1, taskId: 'task-p2-1', requestedCommit: COMMIT_A },
      { databaseTaskId: 2, taskId: 'task-p2-2', requestedCommit: COMMIT_B },
    ]),
    isolateGateFailureMembers: vi.fn(async () => ({ isolated: 1, recomposed: 1 })),
    completeBatch: vi.fn(async () => ['task-p2-1', 'task-p2-2']),
  }
  const consumer = new DeployConsumer(repository as never, {} as never, {} as never)
  const message = createQueueMessage({
    type: 'TEST_RUN_COMPLETED',
    taskId: 'task-p2-1',
    executionId: 'exec-1',
    payload: { phase: 'pre_deploy', status: 'failed', jobId: 975, testRunId: 965 },
  })
  return { consumer, repository, message }
}

describe('DeployConsumer.afterGate — isolamento de membro culpado no gate composto', () => {
  beforeEach(() => {
    gitResponses.mergeBase = { [COMMIT_A]: 'f'.repeat(40), [COMMIT_B]: 'f'.repeat(40) }
    gitResponses.diffFiles = {
      [COMMIT_A]: 'projects/gerenteagentes/motor-v3/src/notifier.ts',
      [COMMIT_B]: 'projects/gerenteagentes/motor-v3/src/start.ts\nprojects/gerenteagentes/motor-v3/src/other.ts',
    }
  })

  it('evidência em 1 membro → isola o culpado, NÃO bloqueia o batch', async () => {
    const { consumer, repository, message } = buildHarness()
    await consumer.handle(message)

    expect(repository.isolateGateFailureMembers).toHaveBeenCalledTimes(1)
    const params = repository.isolateGateFailureMembers.mock.calls[0]![0]
    expect(params.batchId).toBe(BATCH.batchId)
    expect(params.culprits).toEqual([{ databaseTaskId: 2, taskId: 'task-p2-2' }])
    expect(params.reason).toContain('Gate pre_deploy do commit composto falhou')
    expect(params.reason).toContain('exit=2')
    expect(params.evidence).toEqual([
      { databaseTaskId: 2, evidencePath: 'projects/gerenteagentes/motor-v3/src/start.ts', memberFile: 'projects/gerenteagentes/motor-v3/src/start.ts' },
    ])
    // O batch inteiro NÃO pode ser bloqueado quando há inocentes
    expect(repository.completeBatch).not.toHaveBeenCalled()
    // Inocentes voltam à fila
    expect(repository.enqueuePendingDispatches).toHaveBeenCalled()
  })

  it('sem evidência no banco → bloqueio histórico com razão simples', async () => {
    const { consumer, repository, message } = buildHarness({ evidence: null })
    await expect(consumer.handle(message)).rejects.toThrow(/Gate pre_deploy do commit composto falhou/)
    expect(repository.isolateGateFailureMembers).not.toHaveBeenCalled()
    expect(repository.completeBatch).toHaveBeenCalledWith(BATCH.batchId, false, 'Gate pre_deploy do commit composto falhou', expect.anything())
  })

  it('membro único → bloqueio normal com razão enriquecida (exit + cauda)', async () => {
    const { consumer, repository, message } = buildHarness({
      members: [{ databaseTaskId: 2, taskId: 'task-p2-2', requestedCommit: COMMIT_B }],
    })
    await expect(consumer.handle(message)).rejects.toThrow(/exit=2/)
    expect(repository.isolateGateFailureMembers).not.toHaveBeenCalled()
    expect(repository.completeBatch).toHaveBeenCalledTimes(1)
    const reason = String(repository.completeBatch.mock.calls[0]![2])
    expect(reason).toContain('exit=2')
    expect(reason).toContain('TS2304')
  })

  it('todos os membros tocam o arquivo da falha → bloqueio total (ambíguo)', async () => {
    gitResponses.diffFiles = {
      [COMMIT_A]: 'projects/gerenteagentes/motor-v3/src/start.ts',
      [COMMIT_B]: 'projects/gerenteagentes/motor-v3/src/start.ts',
    }
    const { consumer, repository, message } = buildHarness()
    await expect(consumer.handle(message)).rejects.toThrow(/Gate pre_deploy/)
    expect(repository.isolateGateFailureMembers).not.toHaveBeenCalled()
    expect(repository.completeBatch).toHaveBeenCalledTimes(1)
  })

  it('evidência que não toca nenhum membro → bloqueio total', async () => {
    gitResponses.diffFiles = {
      [COMMIT_A]: 'projects/outro/src/a.ts',
      [COMMIT_B]: 'projects/outro/src/b.ts',
    }
    const { consumer, repository, message } = buildHarness()
    await expect(consumer.handle(message)).rejects.toThrow(/Gate pre_deploy/)
    expect(repository.isolateGateFailureMembers).not.toHaveBeenCalled()
    expect(repository.completeBatch).toHaveBeenCalledTimes(1)
  })

  it('source_file de falha estruturada (dry-run de migration) atribui o membro dono do arquivo', async () => {
    gitResponses.diffFiles = {
      [COMMIT_A]: 'projects/gestao-de-tarefas-global/src/a.ts',
      [COMMIT_B]: 'projects/gestao-de-tarefas-global/migrations/0001_smooth_storm.sql\nprojects/gestao-de-tarefas-global/src/b.ts',
    }
    const { consumer, repository, message } = buildHarness({
      evidence: {
        ...TSC_EVIDENCE,
        exitCode: 1,
        stdout: '',
        stderr: 'Dry-run de migrations falhou em tabelas scratch',
        sourceFiles: ['projects/gestao-de-tarefas-global/migrations/0001_smooth_storm.sql'],
      },
    })
    await consumer.handle(message)
    expect(repository.isolateGateFailureMembers).toHaveBeenCalledTimes(1)
    const params = repository.isolateGateFailureMembers.mock.calls[0]![0]
    expect(params.culprits).toEqual([{ databaseTaskId: 2, taskId: 'task-p2-2' }])
  })

  it('git falha ao listar arquivos do membro → conservador: bloqueio total', async () => {
    gitResponses.diffFiles = {}
    const { consumer, repository, message } = buildHarness()
    // diff vazio para todos: nenhum culpado identificável → bloqueio total
    await expect(consumer.handle(message)).rejects.toThrow(/Gate pre_deploy/)
    expect(repository.isolateGateFailureMembers).not.toHaveBeenCalled()
  })
})
