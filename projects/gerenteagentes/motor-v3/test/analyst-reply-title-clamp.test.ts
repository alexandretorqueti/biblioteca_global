import { describe, expect, it } from 'vitest'
import { clampSubtaskTitle, parseAnalystReply, SUBTASK_TITLE_MAX_LENGTH } from '../src/analysis/AnalystReply.js'

function planReply(titulo: string): string {
  return JSON.stringify({
    subtarefas: [
      {
        seq: 1,
        titulo,
        scope: 'packages/ui',
        acceptance_criteria: ['critério'],
        deliverables: ['entrega'],
        requirements_covered: ['R1'],
        depends_on: [],
      },
    ],
    requirements: [{ id: 'R1', description: 'requisito' }],
    coverage: [{ requirement: 'R1', covered_by: [1] }],
  })
}

describe('clampSubtaskTitle — limite varchar(200) de subtarefas.titulo', () => {
  it('preserva títulos dentro do limite', () => {
    expect(clampSubtaskTitle('Corrigir máscara de telefone')).toBe('Corrigir máscara de telefone')
    const exact = 'a'.repeat(SUBTASK_TITLE_MAX_LENGTH)
    expect(clampSubtaskTitle(exact)).toBe(exact)
  })

  it('normaliza espaços e aparas antes de medir', () => {
    expect(clampSubtaskTitle('  título   com    espaços  ')).toBe('título com espaços')
  })

  it('trunca título longo em limite de palavra com reticência, respeitando o limite', () => {
    // Título real do incidente task-p1-1046 (209 caracteres) que causou ER_DATA_TOO_LONG
    const longo =
      'Corrigir defeito residual do formatTelefone (código do país 55 digitado) e adicionar regressões tecla a tecla permanentes (função + FieldText + DynamicForm com config do Colaborador), sem alterar o consumidor'
    expect([...longo].length).toBeGreaterThan(SUBTASK_TITLE_MAX_LENGTH)
    const resultado = clampSubtaskTitle(longo)
    expect([...resultado].length).toBeLessThanOrEqual(SUBTASK_TITLE_MAX_LENGTH)
    expect(resultado.endsWith('…')).toBe(true)
    expect(resultado).toBe(
      'Corrigir defeito residual do formatTelefone (código do país 55 digitado) e adicionar regressões tecla a tecla permanentes (função + FieldText + DynamicForm com config do Colaborador), sem alterar o…',
    )
  })

  it('corta no meio da palavra quando não há espaço na segunda metade', () => {
    const semEspacos = 'x'.repeat(250)
    const resultado = clampSubtaskTitle(semEspacos)
    expect([...resultado].length).toBe(SUBTASK_TITLE_MAX_LENGTH)
    expect(resultado).toBe(`${'x'.repeat(199)}…`)
  })

  it('conta code points (emoji não estoura o limite do MySQL)', () => {
    const comEmojis = `${'😀'.repeat(120)} fim`
    const resultado = clampSubtaskTitle(comEmojis)
    expect([...resultado].length).toBeLessThanOrEqual(SUBTASK_TITLE_MAX_LENGTH)
  })
})

describe('parseAnalystReply — títulos longos são clampados, não rejeitados', () => {
  it('plano com título > 200 caracteres é aceito com título truncado', () => {
    const longo = `Corrigir tudo ${'detalhe '.repeat(40)}`.trim()
    expect([...longo].length).toBeGreaterThan(SUBTASK_TITLE_MAX_LENGTH)
    const outcome = parseAnalystReply(planReply(longo))
    expect(outcome.kind).toBe('plan')
    if (outcome.kind !== 'plan') return
    expect([...outcome.subtasks[0].titulo].length).toBeLessThanOrEqual(SUBTASK_TITLE_MAX_LENGTH)
    expect(outcome.subtasks[0].titulo.endsWith('…')).toBe(true)
  })

  it('título vazio continua inválido', () => {
    expect(() => parseAnalystReply(planReply('   '))).toThrow(/incompleta/)
  })
})
