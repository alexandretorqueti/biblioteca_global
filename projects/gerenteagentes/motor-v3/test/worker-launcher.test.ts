import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
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
  let mocks: Record<string, { handler: ReturnType<typeof vi.fn> }>

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

  it('finaliza resposta de sessão recuperada sem criar ou reenviar prompt', async () => {
    mocks.parseReply.handler.mockResolvedValue({ success: true, data: { hasDoneMarker: true } })
    mocks.verifyGit.handler.mockResolvedValue({ success: true, data: { hasChanges: true } })
    mocks.runBuild.handler.mockResolvedValue({ success: true })

    const result = await launcher.recoverCompletedTask(mockContext, 'Recuperado ::DONE::')

    expect(result).toMatchObject({ success: true, attempts: 1, hasChanges: true, buildPassed: true })
    expect(mocks.createSession.handler).not.toHaveBeenCalled()
    expect(mocks.sendMessage.handler).not.toHaveBeenCalled()
    expect(mocks.waitForCompletion.handler).not.toHaveBeenCalled()
  })

  it('envia o contexto longo antes do header e aguarda somente após o header', async () => {
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({ success: true, data: { response: 'Pronto ::DONE::' } })
    mocks.parseReply.handler.mockResolvedValue({ success: true, data: { hasDoneMarker: true } })
    mocks.verifyGit.handler.mockResolvedValue({ success: true, data: { hasChanges: true } })
    mocks.runBuild.handler.mockResolvedValue({ success: true })

    const result = await launcher.executeTask(mockContext, {
      header: 'Execute a subtarefa.', context: 'Descrição completa da missão:\n\n' + 'D'.repeat(12_001),
    })

    expect(result.success).toBe(true)
    expect(mocks.sendMessage.handler).toHaveBeenCalledTimes(2)
    expect(mocks.sendMessage.handler.mock.calls.map(([, params]: [PrimitiveContext, { message: string }]) => params.message)).toEqual([
      expect.stringContaining('Descrição completa da missão'),
      'Execute a subtarefa.',
    ])
    expect(mocks.waitForCompletion.handler).toHaveBeenCalledTimes(1)
  })

  it('pede conclusão na mesma sessão quando não recebe ::DONE::', async () => {
    // Primeira tentativa: sem marcador
    mocks.createSession.handler.mockImplementation(async (context: PrimitiveContext) => {
      context.sessionId = 'sessao-original'
      return { success: true }
    })
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
    expect(mocks.createSession.handler).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage.handler.mock.calls[1][1].message).toContain('Implementar feature X')
    expect(mocks.sendMessage.handler.mock.calls[1][1].message).toContain('/tmp/worktree')
    expect(mocks.sendMessage.handler.mock.calls[1][1].message).toContain('::DONE::')
  })

  it('preserva contexto e cabeçalho longos na solicitação de continuidade', async () => {
    mocks.createSession.handler.mockImplementation(async (context: PrimitiveContext) => {
      context.sessionId = 'sessao-original'
      return { success: true }
    })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({ success: true, data: { response: 'Ainda trabalhando...' } })
    mocks.parseReply.handler
      .mockResolvedValueOnce({ success: true, data: { hasDoneMarker: false } })
      .mockResolvedValueOnce({ success: true, data: { hasDoneMarker: true } })
    mocks.verifyGit.handler.mockResolvedValue({ success: true, data: { hasChanges: true } })
    mocks.runBuild.handler.mockResolvedValue({ success: true })

    await launcher.executeTask(mockContext, {
      context: 'Contexto original da tarefa',
      header: 'Execute a alteração solicitada',
    })

    const continuation = mocks.sendMessage.handler.mock.calls[2][1].message
    expect(continuation).toContain('Contexto original da tarefa')
    expect(continuation).toContain('Execute a alteração solicitada')
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

  it('devolve somente a regressão nova ao DEV e repete o último modelo disponível', async () => {
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({ success: true, data: { response: 'Pronto ::DONE::' } })
    mocks.parseReply.handler.mockResolvedValue({ success: true, data: { hasDoneMarker: true } })
    mocks.verifyGit.handler.mockResolvedValue({ success: true, data: { hasChanges: true } })
    const differentialGate = vi.fn()
      .mockResolvedValueOnce({ success: false, runId: 20, newFailureCount: 1, error: '1. tests/new.test.ts: erro novo' })
      .mockResolvedValueOnce({ success: true, runId: 21, newFailureCount: 0, preExistingFailureCount: 2 })

    const result = await launcher.executeTask(mockContext, 'Alterar texto', ['modelo-dev'], undefined, differentialGate)

    expect(result).toMatchObject({ success: true, attempts: 2, model: 'modelo-dev', postDevRunId: 21, preExistingFailureCount: 2 })
    expect(differentialGate).toHaveBeenNthCalledWith(1, expect.any(Object), 'post_dev')
    expect(differentialGate).toHaveBeenNthCalledWith(2, expect.any(Object), 'rework')
    const sent = mocks.sendMessage.handler.mock.calls.map(([, params]: [PrimitiveContext, { message: string }]) => params.message)
    expect(sent[1]).toContain('CORREÇÃO OBRIGATÓRIA DA TENTATIVA ANTERIOR')
    expect(sent[1]).toContain('tests/new.test.ts: erro novo')
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

  it('diagnostica diff relacionado no checkout principal sem modificar arquivos', async () => {
    const repo = mkdtempSync(`${tmpdir()}/motor-wrong-checkout-`)
    try {
      mkdirSync(`${repo}/src`)
      writeFileSync(`${repo}/src/Worker.ts`, 'export const value = 1\n')
      execFileSync('git', ['init'], { cwd: repo })
      execFileSync('git', ['add', '.'], { cwd: repo })
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], { cwd: repo })
      writeFileSync(`${repo}/src/Worker.ts`, 'export const value = 2\n')
      launcher = new WorkerLauncher({ maxAttempts: 1 })
      mockContext.repoPath = repo
      mockContext.worktreePath = `${repo}-worktree`
      mocks.createSession.handler.mockResolvedValue({ success: true })
      mocks.sendMessage.handler.mockResolvedValue({ success: true })
      mocks.waitForCompletion.handler.mockResolvedValue({ success: true, data: { response: 'Feito ::DONE::' } })
      mocks.parseReply.handler.mockResolvedValue({ success: true, data: { hasDoneMarker: true } })
      mocks.verifyGit.handler.mockResolvedValue({ success: true, data: { hasChanges: false } })

      const result = await launcher.executeTask(mockContext, {
        header: 'Altere src/Worker.ts', context: null, scopeEvidence: ['src/Worker.ts'],
      })

      expect(result.error).toContain('ALTERAÇÕES ENCONTRADAS NO REPOSITÓRIO PRINCIPAL: src/Worker.ts')
      expect(result.wrongCheckoutDiagnostic).toMatchObject({ kind: 'main_repo_related_changes', files: ['src/Worker.ts'] })
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toContain('src/Worker.ts')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('conclui análise sem alteração Git quando o contrato permite no_code_change', async () => {
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({ success: true, data: { response: 'Diagnóstico final ::DONE::' } })
    mocks.parseReply.handler.mockResolvedValue({ success: true, data: { hasDoneMarker: true } })
    mocks.verifyGit.handler.mockResolvedValue({ success: true, data: { hasChanges: false } })

    const result = await launcher.executeTask(mockContext, 'Analisar arquitetura', ['modelo'], undefined, undefined, true)

    expect(result).toMatchObject({ success: true, hasChanges: false, buildPassed: true, attempts: 1 })
    expect(mocks.runBuild.handler).not.toHaveBeenCalled()
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

  it('roteia o esgotamento do worker pelo catálogo sem alterar o resultado de falha', async () => {
    mocks.createSession.handler.mockResolvedValue({ success: true })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({ success: true, data: { response: 'Ainda trabalhando...' } })
    mocks.parseReply.handler.mockResolvedValue({ success: true, data: { hasDoneMarker: false } })
    const governedFailureHandler = { handleFailure: vi.fn().mockResolvedValue({ governed: true }) }
    launcher = new WorkerLauncher({ maxAttempts: 2, governedFailureHandler: governedFailureHandler as any })

    const result = await launcher.executeTask(mockContext, 'Implementar feature X')

    expect(result).toMatchObject({ success: false, attempts: 2 })
    expect(governedFailureHandler.handleFailure).toHaveBeenCalledWith(
      'worker_exhausted',
      expect.objectContaining({ taskId: 'task-123', subtaskId: 456, metadata: expect.objectContaining({ maxAttempts: 2 }) }),
      expect.objectContaining({ code: 'WORKER_EXHAUSTED' }),
    )
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

  it('entrega sessão DEV ainda ativa ao reconciliador em vez de falhar', async () => {
    launcher = new WorkerLauncher({
      maxAttempts: 3, timeoutMs: 1_000, globalTimeoutMs: 1_500,
      handoffSessionOnTimeout: true, sandboxRoot: '/tmp/sandbox',
    })
    mocks.createSession.handler.mockImplementation(async (context: PrimitiveContext) => {
      context.sessionId = 'sessao-longa'
      context.sessionKey = 'dev-modelo-task-123-s456'
      return { success: true }
    })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler.mockResolvedValue({ success: false, error: 'Timeout aguardando conclusão do run' })

    const result = await launcher.executeTask(mockContext, 'Implementar feature X')

    expect(result).toMatchObject({ success: false, sessionHandedOff: true, attempts: 1 })
    expect(mocks.createSession.handler).toHaveBeenCalledTimes(1)
  })

  it('usa o próximo modelo e uma nova geração quando a sessão remota falha', async () => {
    const attempts: Array<{ model?: string; generation: number }> = []
    mocks.createSession.handler.mockImplementation(async (context: PrimitiveContext) => {
      attempts.push({ model: context.model, generation: context.generation })
      return { success: true }
    })
    mocks.sendMessage.handler.mockResolvedValue({ success: true })
    mocks.waitForCompletion.handler
      .mockResolvedValueOnce({ success: false, error: 'Run falhou: 429 quota exhausted' })
      .mockResolvedValueOnce({ success: true, data: { response: 'Feito ::DONE::' } })
    mocks.parseReply.handler.mockResolvedValue({ success: true, data: { hasDoneMarker: true } })
    mocks.verifyGit.handler.mockResolvedValue({ success: true, data: { hasChanges: true } })
    mocks.runBuild.handler.mockResolvedValue({ success: true })

    const onModelFailure = vi.fn().mockResolvedValue(undefined)
    const result = await launcher.executeTask(mockContext, 'Implementar feature X', ['modelo-sem-cota', 'modelo-reserva'], onModelFailure)

    expect(result.success).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.model).toBe('modelo-reserva')
    expect(attempts).toEqual([
      { model: 'modelo-sem-cota', generation: 1 },
      { model: 'modelo-reserva', generation: 2 },
    ])
    expect(onModelFailure).toHaveBeenCalledWith('modelo-sem-cota', 'Run falhou: 429 quota exhausted')
  })
})
// @vitest-environment node
