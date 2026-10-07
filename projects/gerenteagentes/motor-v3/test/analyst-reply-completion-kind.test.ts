import { describe, expect, it } from 'vitest'
import { parseAnalystReply } from '../src/analysis/AnalystReply.js'

describe('parseAnalystReply completion_kind', () => {
  it('preserva subtarefa analítica sem alteração de código', () => {
    const result = parseAnalystReply(JSON.stringify({
      subtarefas: [{
        seq: 1, titulo: 'Analisar fluxo', scope: 'Inspecionar e relatar',
        acceptance_criteria: ['Relatório objetivo'], deliverables: ['Diagnóstico'],
        requirements_covered: ['REQ-1'], depends_on: [], completion_kind: 'analysis',
      }],
      requirements: [{ id: 'REQ-1', description: 'Produzir análise' }],
      coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
    }))
    expect(result.kind).toBe('plan')
    if (result.kind === 'plan') expect(result.subtasks[0]?.completionKind).toBe('analysis')
  })

  it('aproveita o JSON final quando a análise contém prosa e objetos de código antes dele', () => {
    const response = [
      'Análise concluída. O componente usa `${saudacao}, ${usuario?.nome}`.',
      '```json',
      JSON.stringify({
        subtarefas: [{
          seq: 1, titulo: 'Corrigir sessão', scope: 'Preservar usuário autenticado',
          acceptance_criteria: ['Nome exibido'], deliverables: ['Código'],
          requirements_covered: ['REQ-1'], depends_on: [],
        }],
        requirements: [{ id: 'REQ-1', description: 'Exibir nome real' }],
        coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
      }),
      '```',
    ].join('\n')

    expect(parseAnalystReply(response)).toMatchObject({ kind: 'plan', subtasks: [{ titulo: 'Corrigir sessão' }] })
  })

  it('infere analysis para validação sem completion_kind, tolerando caixa e acentuação', () => {
    const result = parseAnalystReply(JSON.stringify({
      subtarefas: [{
        seq: 1, titulo: 'VÁLIDAR migração', scope: 'Conferir a consistência da execução',
        acceptance_criteria: ['Migração consistente'], deliverables: ['Evidência'],
        requirements_covered: ['REQ-1'], depends_on: [],
      }],
      requirements: [{ id: 'REQ-1', description: 'Validar migração' }],
      coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
    }))
    expect(result).toMatchObject({ kind: 'plan', subtasks: [{ completionKind: 'analysis', completionKindInference: { reason: expect.stringContaining('verbo de validação') } }] })
  })

  it('infere code_change para implementação sem completion_kind', () => {
    const result = parseAnalystReply(JSON.stringify({
      subtarefas: [{
        seq: 1, titulo: 'Implementar classificação', scope: 'Alterar a normalização do plano',
        acceptance_criteria: ['Classificação aplicada'], deliverables: ['Código'],
        requirements_covered: ['REQ-1'], depends_on: [],
      }],
      requirements: [{ id: 'REQ-1', description: 'Classificar plano' }],
      coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
    }))
    expect(result).toMatchObject({ kind: 'plan', subtasks: [{ completionKind: 'code_change', completionKindInference: { reason: expect.stringContaining('não contêm') } }] })
  })
})
// @vitest-environment node
