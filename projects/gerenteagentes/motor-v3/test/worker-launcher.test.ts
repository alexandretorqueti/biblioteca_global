import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkerLauncher } from '../src/worker-launcher/WorkerLauncher.js'
import type { PrimitiveContext } from '../src/primitives/types.js'

// Mock das primitivas
vi.mock('../src/primitives/index.js', () => ({
  createSession: {
    handler: vi.fn(),
  },
  sendMessage: {
    handler: vi.fn(),
  },
  waitForCompletion: {
    handler: vi.fn(),
  },
  parseReply: {
    handler: vi.fn(),
  },
  verifyGit: {
    handler: vi.fn(),
  },
  runBuild: {
    handler: vi.fn(),
  },
}))

describe('WorkerLauncher', () => {
  let launcher: WorkerLauncher
  let mockContext: PrimitiveContext
  let mocks: any

  beforeEach(async () => {
    vi.clearAllMocks()
    
    mocks = await import('../src/primitives/index.js')
    
    launcher = new WorkerLauncher({
      maxAttempts: 3,
      timeoutMs: 1000,
      sandboxRoot: '/tmp/sandbox',
    })

    mockContext = {
      taskId: 'task-123',
      subtaskId: 456,
      executionId: 'exec-789',
      generation: 1,
      projectSlug: 'test-project',
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      branchName: 'motor-v3/task-123/sub-456/a1',
      agentId: 'test-agent',
      db: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }
  })

  it('should execute task successfully on first attempt', async () => {
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({
      success: true,
      data: { response: 'Fiz as alterações. ::DONE::' },
    })
    mocks.parseReply.handler.mockResolvedValue({
      success: true,
      data: { hasDoneMarker: true },
    })
    mocks.verifyGit.handler.mockResolvedValue({
      success: true,
      data: { hasChanges: true },
    })
    mocks.runBuild.handler.mockResolvedValue({ success: true })

    const result = await launcher.executeTask(mockContext, 'Implementar feature X')

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.hasChanges).toBe(true)
    expect(result.buildPassed).toBe(true)
  })

  it('should retry when no ::DONE:: marker found', async () => {
    // Primeira tentativa: sem marcador
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({
      success: true,
      data: { response: 'Ainda trabalhando...' },
    })
    mocks.parseReply.handler.mockResolvedValueOnce({
      success: true,
      data: { hasDoneMarker: false },
    })

    // Segunda tentativa: com marcador
    mocks.parseReply.handler.mockResolvedValueOnce({
      success: true,
      data: { hasDoneMarker: true },
    })
    mocks.verifyGit.handler.mockResolvedValue({
      success: true,
      data: { hasChanges: true },
    })
    mocks.runBuild.handler.mockResolvedValue({ success: true })

    const result = await launcher.executeTask(mockContext, 'Implementar feature X')

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(2)
  })

  it('should retry when build fails', async () => {
    // Primeira tentativa: build falha
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({
      success: true,
      data: { response: 'Pronto ::DONE::' },
    })
    mocks.parseReply.handler.mockResolvedValue({
      success: true,
      data: { hasDoneMarker: true },
    })
    mocks.verifyGit.handler.mockResolvedValue({
      success: true,
      data: { hasChanges: true },
    })
    mocks.runBuild.handler.mockResolvedValueOnce({ success: false, error: 'Test failed' })

    // Segunda tentativa: build passa
    mocks.runBuild.handler.mockResolvedValueOnce({ success: true })

    const result = await launcher.executeTask(mockContext, 'Implementar feature X')

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.buildPassed).toBe(true)
  })

  it('should fail when no changes detected despite ::DONE::', async () => {
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({
      success: true,
      data: { response: 'Pronto ::DONE::' },
    })
    mocks.parseReply.handler.mockResolvedValue({
      success: true,
      data: { hasDoneMarker: true },
    })
    mocks.verifyGit.handler.mockResolvedValue({
      success: true,
      data: { hasChanges: false }, // Sem mudanças
    })

    const result = await launcher.executeTask(mockContext, 'Implementar feature X')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Esgotado número máximo de tentativas')
    expect(mockContext.logger?.warn).toHaveBeenCalledWith(
      'Agente disse ::DONE:: mas não há mudanças no git'
    )
  })

  it('should exhaust max attempts and fail', async () => {
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({
      success: true,
      data: { response: 'Trabalhando...' },
    })
    mocks.parseReply.handler.mockResolvedValue({
      success: true,
      data: { hasDoneMarker: false }, // Nunca indica conclusão
    })

    const result = await launcher.executeTask(mockContext, 'Implementar feature X')

    expect(result.success).toBe(false)
    expect(result.attempts).toBe(3)
    expect(result.error).toContain('Esgotado número máximo de tentativas (3)')
  })

  it('should handle session creation failure', async () => {
    mocks.createSession.handler.mockResolvedValue({
      success: false,
      error: 'Sandbox unavailable',
    })

    const result = await launcher.executeTask(mockContext, 'Implementar feature X')

    expect(result.success).toBe(false)
    expect(mockContext.logger?.error).toHaveBeenCalledWith(
      'Falha ao criar sessão',
      { error: 'Sandbox unavailable' }
    )
  })
})
