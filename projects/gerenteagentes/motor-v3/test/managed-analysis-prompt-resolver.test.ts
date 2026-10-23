// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ManagedAnalysisPromptResolver } from '../src/analysis/ManagedAnalysisPromptResolver.js'
import type { TaskSnapshot } from '../src/coordinator/TaskCoordinator.js'

describe('ManagedAnalysisPromptResolver', () => {
  it('substitui o schema inline por referência versionada e mantém o schema para validação', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        prompt_id: 1, version_id: 48,
        texto: 'Analise **TITULOTAREFA**.\n**CONTRATOSAIDA**',
        contract_version_id: 9, instrucoes: 'Somente JSON.',
        schema_json: JSON.stringify({ type: 'object' }), exemplo_json: JSON.stringify({ ok: true }),
      }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 77 }])
      .mockResolvedValueOnce([{}])
    const pool = { query } as any
    const artifacts = { materialize: vi.fn(async () => ({ path: '/runtime/contract.json', version: 9, sha256: 'abc123' })) }
    const resolver = new ManagedAnalysisPromptResolver(pool, artifacts as any)
    const task: TaskSnapshot = {
      taskId: 'task-1', title: 'Tarefa', description: 'Descrição', taskType: 'desenvolvimento',
      agentId: 'agente', projectSlug: 'projeto', repoPath: '/repo', status: 'planned',
      paused: false, terminal: false, analysisStartedAt: null, subtaskCount: 0,
    }

    const resolved = await resolver.resolve(task, 'execution-1')

    expect(resolved.text).toContain('Caminho: /runtime/contract.json')
    expect(resolved.text).toContain('SHA-256: abc123')
    expect(resolved.text).not.toContain('JSON SCHEMA OBRIGATÓRIO')
    expect(resolved.contractSchema).toEqual({ type: 'object' })
    expect(artifacts.materialize).toHaveBeenCalledWith(expect.objectContaining({ contractVersionId: 9 }))
  })

  it('retomada após clarificação usa a chave de retomada com referência compacta, histórico e confirmação da resposta', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{
        prompt_id: 2, version_id: 49,
        texto: 'Continue **TITULOTAREFA**. Referência: **DESCRICAOTAREFA**. Histórico: **HISTORICOCLARIFICACAO**.\n\n**CONTRATOSAIDA**',
        contract_version_id: null, instrucoes: 'Somente JSON.', schema_json: null, exemplo_json: null,
      }]])
      .mockResolvedValueOnce([[
        { role: 'analyst', texto: '{"summary":"preciso confirmar","questions":["Prefere A ou B?"]}' },
        { role: 'user', texto: 'Prefiro A' },
      ]])
      .mockResolvedValueOnce([{ insertId: 88 }])
      .mockResolvedValueOnce([{}])
    const pool = { query } as any
    const artifacts = { materialize: vi.fn() }
    const resolver = new ManagedAnalysisPromptResolver(pool, artifacts as any)
    const task: TaskSnapshot = {
      taskId: 'task-1', title: 'Tarefa', description: 'Descrição integral que não deve ser reenviada', taskType: 'desenvolvimento',
      agentId: 'agente', projectSlug: 'projeto', repoPath: '/repo', status: 'awaiting_clarification',
      paused: false, terminal: false, analysisStartedAt: null, subtaskCount: 0,
    }

    const resolved = await resolver.resolve(task, 'exec-resume-1', {
      descriptionReference: '(descrição já enviada nesta sessão — não reenviada)',
      confirmation: '[RETOMADA] Resposta do usuário: Prefiro A. Não repita perguntas já respondidas.',
      chunkCount: 0,
      descriptionLength: 52,
    })

    // Chave de retomada selecionada pelo status awaiting_clarification.
    expect(query.mock.calls[0][1]).toContain('analista.retomada_apos_clarificacao')
    // Continuação contextual: referência compacta no lugar da descrição integral,
    // histórico de clarificação e confirmação com a resposta do usuário.
    expect(resolved.text).toContain('(descrição já enviada nesta sessão — não reenviada)')
    expect(resolved.text).not.toContain('Descrição integral que não deve ser reenviada')
    expect(resolved.text).toContain('Mensagem do usuário: Prefiro A')
    expect(resolved.text).toContain('[RETOMADA] Resposta do usuário: Prefiro A. Não repita perguntas já respondidas.')
    // Auditoria append-only da execução de prompt.
    const insert = query.mock.calls.find(call => String(call[0]).includes('INSERT INTO prompts_execucoes'))
    expect(insert?.[1]).toContain('analista.retomada_apos_clarificacao')
    const update = query.mock.calls.find(call => String(call[0]).includes('UPDATE prompts_execucoes SET prompt_final'))
    expect(String(update?.[1][0])).toContain('[RETOMADA] Resposta do usuário: Prefiro A')
    expect(artifacts.materialize).not.toHaveBeenCalled()
  })
})
