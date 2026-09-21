import { describe, expect, it, vi } from 'vitest'
import { ConsoleAnalystRunner, type AnalystConsole, type AnalystSession } from '../src/analysis/ConsoleAnalystRunner.js'
import {
  buildAnalysisContextMessage,
  isContextAcknowledgement,
  splitAnalysisDescription,
} from '../src/analysis/PromptChunking.js'
import type { TaskSnapshot } from '../src/coordinator/TaskCoordinator.js'

const task = (description: string): TaskSnapshot => ({
  taskId: 'task-1', title: 'Tarefa de teste', description, taskType: 'desenvolvimento', agentId: 'agent-1',
  projectSlug: 'projeto', repoPath: '/tmp/projeto', status: 'planned', paused: false,
  terminal: false, analysisStartedAt: null, subtaskCount: 0,
})

const plan = JSON.stringify({
  subtarefas: [{ seq: 1, titulo: 'Implementar', scope: 'Alterar o código', acceptance_criteria: ['Funciona'], deliverables: ['Código'], requirements_covered: ['REQ-1'], depends_on: [] }],
  requirements: [{ id: 'REQ-1', description: 'Requisito' }],
  coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
})

function consoleWithResponses(responses: string[]): AnalystConsole & { sendMessage: ReturnType<typeof vi.fn> } {
  const session: AnalystSession = { sessionId: 'session-1', sessionKey: 'agent:agent-1:test', agentId: 'agent-1' }
  return {
    createSession: vi.fn(async () => session),
    sendMessage: vi.fn(async () => {}),
    getSessionStatus: vi.fn(async () => ({ isComplete: true, lastResponse: responses.shift() })),
  }
}

describe('PromptChunking', () => {
  it('divide sem perda e preserva o fim da descrição', () => {
    const description = 'A'.repeat(6_000) + 'B'.repeat(6_000) + 'FIM'
    const chunks = splitAnalysisDescription(description)

    expect(chunks).toHaveLength(3)
    expect(chunks.join('')).toBe(description)
    expect(chunks.at(-1)).toBe('FIM')
  })

  it('monta bloco identificado e reconhece somente a confirmação do protocolo', () => {
    expect(buildAnalysisContextMessage('conteúdo', 1, 3)).toContain('BLOCO 2/3')
    expect(isContextAcknowledgement(' CONTEXTO_RECEBIDO. ')).toBe(true)
    expect(isContextAcknowledgement('CONTEXTO_RECEBIDO, vou analisar agora')).toBe(false)
  })
})

describe('ConsoleAnalystRunner — contexto em etapas', () => {
  it('envia cada bloco, aguarda confirmação e somente depois envia o prompt final', async () => {
    const api = consoleWithResponses(['CONTEXTO_RECEBIDO', 'CONTEXTO_RECEBIDO', plan])
    const resolver = { resolve: vi.fn(async (_task: TaskSnapshot, _executionId: string, context?: { descriptionReference: string; confirmation: string; chunkCount: number; descriptionLength: number }) => ({
      text: `Prompt final\n${context?.descriptionReference}\n${context?.confirmation}`,
      contractText: '', contractSchema: undefined,
    })) }
    const runner = new ConsoleAnalystRunner(api, { pollIntervalMs: 1, promptResolver: resolver })
    const description = 'A'.repeat(6_000) + 'FIM'

    const result = await runner.start(task(description), 'execution-1')

    expect(result.kind).toBe('plan')
    expect(resolver.resolve).toHaveBeenCalledWith(expect.any(Object), 'execution-1', expect.objectContaining({ chunkCount: 2, descriptionLength: description.length }))
    expect(api.sendMessage.mock.calls.map(([input]) => input.message)).toEqual([
      expect.stringContaining('BLOCO 1/2'),
      expect.stringContaining('BLOCO 2/2'),
      expect.stringContaining('Prompt final'),
    ])
  })

  it('não envia o prompt final quando a confirmação de um bloco é inválida', async () => {
    const api = consoleWithResponses(['Entendi o contexto'])
    const runner = new ConsoleAnalystRunner(api, { pollIntervalMs: 1 })

    await expect(runner.start(task('descrição'), 'execution-1')).rejects.toThrow('não confirmou o bloco 1/1')
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
  })
})
