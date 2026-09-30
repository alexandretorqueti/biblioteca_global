import { describe, expect, it } from 'vitest'
import { parseAnalystReply, sanitizeModelResponse } from '../src/analysis/AnalystReply.js'

describe('sanitizeModelResponse — thinking/reasoning leak', () => {
  it('remove tags <thinking>...</thinking>', () => {
    const input = '<thinking>Let me think about this problem...</thinking>\n{"subtarefas":[]}'
    expect(sanitizeModelResponse(input)).toBe('{"subtarefas":[]}')
  })

  it('remove tags <reasoning>...</reasoning>', () => {
    const input = '<reasoning>I need to analyze this carefully</reasoning>\n{"subtarefas":[]}'
    expect(sanitizeModelResponse(input)).toBe('{"subtarefas":[]}')
  })

  it('remove blocos Markdown fenced ```thinking', () => {
    const input = '```thinking\nMaybe use single line JSON?\nWe should respond single object.\n```\n{"subtarefas":[]}'
    expect(sanitizeModelResponse(input)).toBe('{"subtarefas":[]}')
  })

  it('remove blocos Markdown fenced ```reasoning', () => {
    const input = '```reasoning\nLet me think...\n```\n{"subtarefas":[]}'
    expect(sanitizeModelResponse(input)).toBe('{"subtarefas":[]}')
  })

  it('remove múltiplos blocos de thinking', () => {
    const input = '<thinking>first thought</thinking>\nSome text\n<thinking>second thought</thinking>\n{"subtarefas":[]}'
    expect(sanitizeModelResponse(input)).toBe('Some text\n\n{"subtarefas":[]}')
  })

  it('preserva conteúdo sem thinking', () => {
    const input = '{"subtarefas":[],"requirements":[],"coverage":[]}'
    expect(sanitizeModelResponse(input)).toBe(input)
  })

  it('preserva conteúdo com JSON dentro de prosa normal', () => {
    const input = 'Aqui está o plano:\n{"subtarefas":[],"requirements":[],"coverage":[]}\nFim.'
    expect(sanitizeModelResponse(input)).toBe(input)
  })
})

describe('parseAnalystReply com thinking leak', () => {
  const validPlan = {
    subtarefas: [{
      seq: 1, titulo: 'Teste', scope: 'Escopo teste',
      acceptance_criteria: ['Critério'], deliverables: ['Entrega'],
      requirements_covered: ['REQ-1'], depends_on: [],
    }],
    requirements: [{ id: 'REQ-1', description: 'Req teste' }],
    coverage: [{ requirement: 'REQ-1', covered_by: [1] }],
  }

  it('extrai JSON válido após bloco <thinking>', () => {
    const input = `<thinking>Let me analyze this task carefully...</thinking>\n${JSON.stringify(validPlan)}`
    const result = parseAnalystReply(input)
    expect(result.kind).toBe('plan')
  })

  it('extrai JSON válido após bloco ```thinking', () => {
    const input = "```thinking\nMaybe use single line JSON? We should respond single object.\n```\n" + JSON.stringify(validPlan)
    const result = parseAnalystReply(input)
    expect(result.kind).toBe('plan')
  })

  it('lança erro informativo quando resposta é puro reasoning sem JSON', () => {
    const input = 'Let me think about this. The schema requires subtasks but I need to analyze first.'
    expect(() => parseAnalystReply(input)).toThrow(/vazamento de reasoning/)
  })

  it('lança erro informativo para conteúdo vazio', () => {
    expect(() => parseAnalystReply('')).toThrow(/não contém JSON/)
  })
})
