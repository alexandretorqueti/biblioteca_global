// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAnalystReply } from '../src/analysis/AnalystReply.js'

/**
 * Contrato v13 do analista (task-p2-1047): campo OPCIONAL `routing` no
 * veredito verification para roteamento cross-project (caso real task-p6-1029:
 * "o problema não é do Admin; é da Biblioteca Global — packages/ui").
 */

/** Espelha o schema do contrato ativo após a migration 0098 (variante verification). */
const contractSchemaV13 = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'verdict', 'summary', 'evidence'],
      properties: {
        kind: { enum: ['verification', 'verificacao'] },
        verdict: { type: 'string', minLength: 1 },
        summary: { type: 'string', minLength: 1 },
        evidence: { type: 'array', items: { type: 'string' } },
        routing: {
          type: 'object',
          additionalProperties: false,
          required: ['target_project_slug'],
          properties: {
            target_project_slug: { type: 'string', minLength: 1 },
            recommended_title: { type: 'string' },
            diagnosis: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'resumo', 'perguntas'],
      properties: {
        kind: { enum: ['perguntas'] },
        resumo: { type: 'string' },
        perguntas: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    },
  ],
}

const caso1029 = {
  kind: 'verification',
  verdict: 'Confirmado',
  summary: 'O problema não é do Admin; é da Biblioteca Global — packages/ui.',
  evidence: ['Leitura de packages/ui/src/Card.tsx'],
  routing: {
    target_project_slug: 'biblioteca-global',
    recommended_title: 'Corrigir renderização do cartão em packages/ui',
    diagnosis: 'O defeito está no componente da Biblioteca Global (packages/ui), não no Admin.',
  },
}

describe('parseAnalystReply routing cross-project (contrato v13)', () => {
  it('aceita veredito verification com routing válido e tipa o campo', () => {
    const result = parseAnalystReply(JSON.stringify(caso1029), undefined, 'verificacao')
    expect(result.kind).toBe('verification')
    if (result.kind !== 'verification') return
    expect(result.routing).toEqual({
      targetProjectSlug: 'biblioteca-global',
      recommendedTitle: 'Corrigir renderização do cartão em packages/ui',
      diagnosis: 'O defeito está no componente da Biblioteca Global (packages/ui), não no Admin.',
    })
    expect(result.verdict).toBe('Confirmado')
    expect(result.summary).toContain('Biblioteca Global')
    expect(result.evidence).toEqual(['Leitura de packages/ui/src/Card.tsx'])
  })

  it('aceita routing apenas com target_project_slug (opcionais ausentes)', () => {
    const result = parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'S.', evidence: [],
      routing: { target_project_slug: 'taqui' },
    }), undefined, 'verificacao')
    expect(result).toMatchObject({ kind: 'verification', routing: { targetProjectSlug: 'taqui' } })
    if (result.kind === 'verification') {
      expect(result.routing?.recommendedTitle).toBeUndefined()
      expect(result.routing?.diagnosis).toBeUndefined()
    }
  })

  it('mantém compatibilidade v12: verification sem routing continua aceito e sem campo routing', () => {
    const result = parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'Fluxo validado.', evidence: ['Evidência'],
    }), undefined, 'verificacao')
    expect(result).toEqual({
      kind: 'verification', verdict: 'Confirmado', summary: 'Fluxo validado.', evidence: ['Evidência'],
    })
    if (result.kind === 'verification') expect(result.routing).toBeUndefined()
  })

  it('tolera routing explicitamente nulo como ausente (compat v12)', () => {
    const result = parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'S.', evidence: [], routing: null,
    }), undefined, 'verificacao')
    expect(result).toMatchObject({ kind: 'verification' })
    if (result.kind === 'verification') expect(result.routing).toBeUndefined()
  })

  it('rejeita routing sem target_project_slug com erro claro', () => {
    expect(() => parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'S.', evidence: [],
      routing: { recommended_title: 'Título sem slug' },
    }), undefined, 'verificacao')).toThrow('routing.target_project_slug é obrigatório')
  })

  it('rejeita routing com target_project_slug vazio ou de tipo inválido', () => {
    expect(() => parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'S.', evidence: [],
      routing: { target_project_slug: '   ' },
    }), undefined, 'verificacao')).toThrow('routing.target_project_slug é obrigatório')
    expect(() => parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'S.', evidence: [],
      routing: { target_project_slug: 42 },
    }), undefined, 'verificacao')).toThrow('routing.target_project_slug é obrigatório')
  })

  it('rejeita routing que não é objeto JSON', () => {
    expect(() => parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'S.', evidence: [],
      routing: 'biblioteca-global',
    }), undefined, 'verificacao')).toThrow('routing do veredito verification deve ser um objeto JSON')
  })

  it('rejeita campos opcionais de routing com tipo inválido', () => {
    expect(() => parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'S.', evidence: [],
      routing: { target_project_slug: 'biblioteca-global', diagnosis: { texto: 'não é string' } },
    }), undefined, 'verificacao')).toThrow('routing.diagnosis deve ser string')
  })

  it('valida contra o schema do contrato v13 com e sem routing', () => {
    expect(() => parseAnalystReply(JSON.stringify(caso1029), contractSchemaV13, 'verificacao')).not.toThrow()
    expect(() => parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'Sem routing (v12).', evidence: [],
    }), contractSchemaV13, 'verificacao')).not.toThrow()
  })

  it('não altera o schema de saída dos outros kinds (perguntas/plano)', () => {
    const questions = parseAnalystReply(JSON.stringify({
      kind: 'perguntas', resumo: 'Preciso confirmar', perguntas: ['Prefere A ou B?'],
    }), contractSchemaV13)
    expect(questions).toEqual({ kind: 'questions', summary: 'Preciso confirmar', questions: ['Prefere A ou B?'] })
    expect(questions).not.toHaveProperty('routing')

    const plan = parseAnalystReply(JSON.stringify({
      subtarefas: [{
        seq: 1, titulo: 'Implementar X', scope: 'Alterar Y',
        acceptance_criteria: ['OK'], deliverables: ['Código'],
        requirements_covered: ['REQ-1'], depends_on: [], completion_kind: 'code_change',
      }],
      requirements: [{ id: 'REQ-1', description: 'X' }],
      coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
    }))
    expect(plan.kind).toBe('plan')
    expect(plan).not.toHaveProperty('routing')
  })

  it('normaliza espaços do slug e preserva acentuação do diagnóstico', () => {
    const result = parseAnalystReply(JSON.stringify({
      kind: 'verification', verdict: 'Confirmado', summary: 'S.', evidence: [],
      routing: { target_project_slug: '  biblioteca-global  ', diagnosis: '  Diagnóstico acentuado.  ' },
    }), undefined, 'verificacao')
    if (result.kind === 'verification') {
      expect(result.routing?.targetProjectSlug).toBe('biblioteca-global')
      expect(result.routing?.diagnosis).toBe('Diagnóstico acentuado.')
    }
  })
})
