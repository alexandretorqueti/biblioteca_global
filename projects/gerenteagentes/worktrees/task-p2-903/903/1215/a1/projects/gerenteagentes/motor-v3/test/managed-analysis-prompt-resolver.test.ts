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
})
