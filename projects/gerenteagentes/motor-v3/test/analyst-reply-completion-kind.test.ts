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
})
// @vitest-environment node
