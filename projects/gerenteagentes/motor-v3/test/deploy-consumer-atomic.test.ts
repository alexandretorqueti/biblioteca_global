import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock node:child_process para evitar chamadas reais ao git no promote()
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
    if (cb) cb(null, { stdout: '', stderr: '' })
  }),
}))

import { DeployConsumer } from '../src/deploy/DeployConsumer.js'
import type { OperationLogEntry, OperationLogger } from '../src/commands/index.js'
import type { DeployBatch } from '../src/deploy/DeployRepository.js'
import { createQueueMessage } from '../src/queue/index.js'

/**
 * Teste de integração do deploy atômico: simula deploy durante análise em andamento.
 * Valida o fluxo: acquireLock → waitForIdle → deploy → releaseLock → resumeTasks.
 *
 * Regressão: tarefa 873 perdeu análise durante deploy porque o motor não pausava
 * antes do deploy. Agora o DeployConsumer adquire lock, aguarda execuções ativas
 * terminarem (ou pausa forçadamente após timeout), executa o deploy, e só depois
 * libera o lock e retoma as tarefas adiadas.
 */

function makeBatch(overrides: Partial<DeployBatch> = {}): DeployBatch {
  return {
    batchId: 'batch-atomic-test',
    repoPath: '/repo',
    baseBranch: 'base-desenvolvimento',
    expectedCommit: 'abc1234567890',
    status: 'pending',
    remotePid: null,
    remoteStatusPath: null,
    startedAt: null,
    workspacePath: '/worktree/batch-atomic-test',
    gateJobId: 1,
    ...overrides,
  }
}

function makeMessage() {
  return createQueueMessage({
    type: 'DEPLOY_BATCH_DISPATCH_REQUESTED',
    taskId: '873',
    executionId: 'deploy-atomic-test',
    payload: { batchId: 'batch-atomic-test' },
  })
}

function captureLogger() {
  const entries: OperationLogEntry[] = []
  const logger: OperationLogger = {
    async append(entry: OperationLogEntry): Promise<void> {
      entries.push(entry)
    },
  }
  return { logger, entries }
}

describe('DeployConsumer.startPreparedBatch — deploy atômico', () => {
  it('adquire lock, aguarda execuções ativas, executa deploy, libera lock e retoma tarefas', async () => {
    const { logger, entries } = captureLogger()
    const acquireDeployLock = vi.fn().mockResolvedValue(true)
    const releaseDeployLock = vi.fn().mockResolvedValue(undefined)
    const waitForActiveExecutionsToComplete = vi.fn().mockResolvedValue({ completed: true, forced: false })
    const markRemoteStarted = vi.fn().mockResolvedValue(undefined)
    const enqueuePendingDispatches = vi.fn().mockResolvedValue(0)
    const repository = {
      acquireDeployLock,
      releaseDeployLock,
      waitForActiveExecutionsToComplete,
      markRemoteStarted,
      enqueuePendingDispatches,
    } as never

    const remote = {
      assertReady: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue({ pid: '12345', statusPath: '/tmp/status', logPath: '/tmp/log' }),
    } as never

    const consumer = new DeployConsumer(
      repository,
      {} as never, // gate
      remote,
      logger,
      undefined, // commandPolicies
      '/host/repo', // hostRepoRoot
      'deploy.sh', // script
    )

    const batch = makeBatch()
    const message = makeMessage()

    // startPreparedBatch é privado; acessamos via (consumer as any)
    await (consumer as any).startPreparedBatch(batch, message)

    // Valida a ordem das chamadas
    expect(acquireDeployLock).toHaveBeenCalledWith('batch-atomic-test', 'Deploy batch batch-atomic-test')
    expect(waitForActiveExecutionsToComplete).toHaveBeenCalledWith(600_000)
    expect(remote.assertReady).toHaveBeenCalled()
    expect(remote.start).toHaveBeenCalled()
    expect(markRemoteStarted).toHaveBeenCalled()
    expect(releaseDeployLock).toHaveBeenCalled()
    expect(enqueuePendingDispatches).toHaveBeenCalled()

    // Valida a ordem: acquire → wait → start → release → enqueue
    const acquireIdx = acquireDeployLock.mock.invocationCallOrder[0]!
    const waitIdx = waitForActiveExecutionsToComplete.mock.invocationCallOrder[0]!
    const startIdx = remote.start.mock.invocationCallOrder[0]!
    const releaseIdx = releaseDeployLock.mock.invocationCallOrder[0]!
    const enqueueIdx = enqueuePendingDispatches.mock.invocationCallOrder[0]!
    expect(acquireIdx).toBeLessThan(waitIdx)
    expect(waitIdx).toBeLessThan(startIdx)
    expect(startIdx).toBeLessThan(releaseIdx)
    expect(releaseIdx).toBeLessThan(enqueueIdx)

    // Valida eventos de log
    const phases = entries.map(e => e.phase)
    expect(phases).toContain('deploy_lock_acquired')
    expect(phases).toContain('deploy_wait_completed')
    expect(phases).toContain('deploy_lock_released')
  })

  it('registra forced_pause_for_deploy quando timeout expira', async () => {
    const { logger, entries } = captureLogger()
    const waitForActiveExecutionsToComplete = vi.fn().mockResolvedValue({ completed: false, forced: true })
    const repository = {
      acquireDeployLock: vi.fn().mockResolvedValue(true),
      releaseDeployLock: vi.fn().mockResolvedValue(undefined),
      waitForActiveExecutionsToComplete,
      markRemoteStarted: vi.fn().mockResolvedValue(undefined),
      enqueuePendingDispatches: vi.fn().mockResolvedValue(0),
    } as never

    const remote = {
      assertReady: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue({ pid: '12345', statusPath: '/tmp/status', logPath: '/tmp/log' }),
    } as never

    const consumer = new DeployConsumer(
      repository,
      {} as never,
      remote,
      logger,
      undefined,
      '/host/repo',
      'deploy.sh',
    )

    const batch = makeBatch()
    const message = makeMessage()

    await (consumer as any).startPreparedBatch(batch, message)

    // Valida que o evento forced_pause_for_deploy foi registrado
    const forcedEvent = entries.find(e => e.phase === 'forced_pause_for_deploy')
    expect(forcedEvent).toBeDefined()
    expect(forcedEvent?.outcome).toBe('succeeded')

    // Valida que o deploy continuou mesmo com timeout (forced=true)
    expect(remote.start).toHaveBeenCalled()
    expect(entries.find(e => e.phase === 'deploy_lock_released')).toBeDefined()
  })

  it('libera lock no finally quando deploy falha', async () => {
    const { logger, entries } = captureLogger()
    const releaseDeployLock = vi.fn().mockResolvedValue(undefined)
    const repository = {
      acquireDeployLock: vi.fn().mockResolvedValue(true),
      releaseDeployLock,
      waitForActiveExecutionsToComplete: vi.fn().mockResolvedValue({ completed: true, forced: false }),
      markRemoteStarted: vi.fn().mockResolvedValue(undefined),
      enqueuePendingDispatches: vi.fn().mockResolvedValue(0),
    } as never

    const remote = {
      assertReady: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockRejectedValue(new Error('SSH connection failed')),
    } as never

    const consumer = new DeployConsumer(
      repository,
      {} as never,
      remote,
      logger,
      undefined,
      '/host/repo',
      'deploy.sh',
    )

    const batch = makeBatch()
    const message = makeMessage()

    await expect((consumer as any).startPreparedBatch(batch, message)).rejects.toThrow('SSH connection failed')

    // Valida que o lock foi liberado mesmo com erro
    expect(releaseDeployLock).toHaveBeenCalled()

    // Valida que o evento de release com falha foi registrado
    const releaseEvent = entries.find(e => e.phase === 'deploy_lock_released')
    expect(releaseEvent).toBeDefined()
    expect(releaseEvent?.outcome).toBe('failed')
  })

  it('lança erro quando lock não pode ser adquirido (outro batch já possui)', async () => {
    const { logger } = captureLogger()
    const repository = {
      acquireDeployLock: vi.fn().mockResolvedValue(false),
      releaseDeployLock: vi.fn().mockResolvedValue(undefined),
      waitForActiveExecutionsToComplete: vi.fn(),
      markRemoteStarted: vi.fn(),
      enqueuePendingDispatches: vi.fn(),
    } as never

    const remote = {
      assertReady: vi.fn(),
      start: vi.fn(),
    } as never

    const consumer = new DeployConsumer(
      repository,
      {} as never,
      remote,
      logger,
      undefined,
      '/host/repo',
      'deploy.sh',
    )

    const batch = makeBatch()
    const message = makeMessage()

    await expect((consumer as any).startPreparedBatch(batch, message)).rejects.toThrow('Lock de deploy já adquirido por outro batch')

    // Valida que nenhuma outra operação foi executada
    expect(remote.assertReady).not.toHaveBeenCalled()
    expect(remote.start).not.toHaveBeenCalled()
    expect(repository.releaseDeployLock).not.toHaveBeenCalled()
  })

  it('simula deploy durante análise em andamento — análise termina antes do timeout', async () => {
    const { logger, entries } = captureLogger()
    // Simula análise em andamento que termina após 2 polls (10s)
    let pollCount = 0
    const waitForActiveExecutionsToComplete = vi.fn().mockImplementation(async () => {
      pollCount++
      // Simula que após 2 polls a análise terminou
      if (pollCount >= 2) {
        return { completed: true, forced: false }
      }
      return { completed: false, forced: false }
    })

    const repository = {
      acquireDeployLock: vi.fn().mockResolvedValue(true),
      releaseDeployLock: vi.fn().mockResolvedValue(undefined),
      waitForActiveExecutionsToComplete,
      markRemoteStarted: vi.fn().mockResolvedValue(undefined),
      enqueuePendingDispatches: vi.fn().mockResolvedValue(0),
    } as never

    const remote = {
      assertReady: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue({ pid: '12345', statusPath: '/tmp/status', logPath: '/tmp/log' }),
    } as never

    const consumer = new DeployConsumer(
      repository,
      {} as never,
      remote,
      logger,
      undefined,
      '/host/repo',
      'deploy.sh',
    )

    const batch = makeBatch()
    const message = makeMessage()

    await (consumer as any).startPreparedBatch(batch, message)

    // Valida que a análise terminou antes do timeout (completed=true, forced=false)
    const waitEvent = entries.find(e => e.phase === 'deploy_wait_completed')
    expect(waitEvent).toBeDefined()

    // Valida que NÃO houve forced_pause_for_deploy (análise terminou normalmente)
    const forcedEvent = entries.find(e => e.phase === 'forced_pause_for_deploy')
    expect(forcedEvent).toBeUndefined()

    // Valida que o deploy foi executado após a análise terminar
    expect(remote.start).toHaveBeenCalled()
  })
})
