/**
 * Testes do logger estruturado
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createLogger, setLogLevel, getLogLevel } from '../src/shared/logger.js'

describe('logger estruturado', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  const originalLevel = getLogLevel()

  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setLogLevel('info')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setLogLevel(originalLevel)
  })

  it('emite linha com timestamp, nível, componente e contexto', () => {
    const logger = createLogger('Teste')

    logger.info('mensagem', { taskId: 'task-1', subtaskId: 7 })

    const line = String(stdoutSpy.mock.calls[0]?.[0])
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO\s+\[Teste\] taskId=task-1 subtaskId=7 mensagem$/)
  })

  it('child herda e mescla contexto de correlação', () => {
    const logger = createLogger('Teste', { executionId: 'exec-1' })

    logger.child({ taskId: 'task-9' }).warn('atenção')

    const line = String(vi.mocked(console.warn).mock.calls[0]?.[0])
    expect(line).toContain('executionId=exec-1')
    expect(line).toContain('taskId=task-9')
  })

  it('respeita o nível configurado', () => {
    const logger = createLogger('Teste')

    logger.debug('não deve sair')
    expect(stdoutSpy).not.toHaveBeenCalled()

    setLogLevel('debug')
    logger.debug('agora sai')
    expect(stdoutSpy).toHaveBeenCalledTimes(1)
  })

  it('erros vão para o stderr com stack quando disponível', () => {
    const logger = createLogger('Teste')

    logger.error('falhou: ' + (new Error('boom').message))

    const line = String(stderrSpy.mock.calls[0]?.[0])
    expect(line).toContain('ERROR')
    expect(line).toContain('falhou: boom')
  })
})
