import { describe, expect, it } from 'vitest'
import { normalizeChatContent } from '../chat-normalizer.js'

describe('normalizeChatContent', () => {
  describe('casos básicos', () => {
    it('retorna string vazia para null/undefined', () => {
      expect(normalizeChatContent(null)).toBe('')
      expect(normalizeChatContent(undefined)).toBe('')
    })

    it('retorna string vazia para string vazia', () => {
      expect(normalizeChatContent('')).toBe('')
      expect(normalizeChatContent('   ')).toBe('')
    })

    it('retorna texto simples sem modificação', () => {
      expect(normalizeChatContent('Olá, mundo!')).toBe('Olá, mundo!')
      expect(normalizeChatContent('  Olá, mundo!  ')).toBe('Olá, mundo!')
    })

    it('converte outros tipos para string', () => {
      expect(normalizeChatContent(42)).toBe('42')
      expect(normalizeChatContent(true)).toBe('true')
    })
  })

  describe('JSON string', () => {
    it('formata JSON de perguntas (clarification)', () => {
      const json = JSON.stringify({
        kind: 'perguntas',
        resumo: 'Entendi que você quer X',
        perguntas: ['Qual o prazo?', 'Qual o orçamento?'],
      })
      const result = normalizeChatContent(json)
      expect(result).toContain('🤔 O analista precisa de esclarecimentos')
      expect(result).toContain('Entendimento atual: Entendi que você quer X')
      expect(result).toContain('1) Qual o prazo?')
      expect(result).toContain('2) Qual o orçamento?')
    })

    it('formata JSON de perguntas sem resumo', () => {
      const json = JSON.stringify({
        perguntas: ['Pergunta 1', 'Pergunta 2'],
      })
      const result = normalizeChatContent(json)
      expect(result).toContain('1) Pergunta 1')
      expect(result).toContain('2) Pergunta 2')
      expect(result).not.toContain('Entendimento atual')
    })

    it('formata JSON de plano de subtarefas', () => {
      const json = JSON.stringify({
        subtarefas: [
          {
            titulo: 'Criar componente',
            scope: 'Implementar o componente X',
            acceptance_criteria: ['Critério 1', 'Critério 2'],
          },
          {
            titulo: 'Testar componente',
            scope: 'Adicionar testes unitários',
            acceptance_criteria: ['Cobertura > 80%'],
          },
        ],
      })
      const result = normalizeChatContent(json)
      expect(result).toContain('📋 Plano de execução gerado')
      expect(result).toContain('**1. Criar componente**')
      expect(result).toContain('Implementar o componente X')
      expect(result).toContain('• Critério 1')
      expect(result).toContain('**2. Testar componente**')
    })

    it('formata JSON genérico como chave-valor', () => {
      const json = JSON.stringify({
        nome: 'Teste',
        status: 'concluído',
      })
      const result = normalizeChatContent(json)
      expect(result).toContain('Nome: Teste')
      expect(result).toContain('Status: concluído')
    })

    it('retorna string original se JSON inválido', () => {
      const invalidJson = '{invalid json'
      expect(normalizeChatContent(invalidJson)).toBe(invalidJson)
    })
  })

  describe('objeto JavaScript', () => {
    it('formata objeto de perguntas', () => {
      const obj = {
        kind: 'perguntas',
        perguntas: ['Pergunta A', 'Pergunta B'],
      }
      const result = normalizeChatContent(obj)
      expect(result).toContain('1) Pergunta A')
      expect(result).toContain('2) Pergunta B')
    })

    it('formata objeto de plano', () => {
      const obj = {
        subtarefas: [
          { titulo: 'Tarefa 1', scope: 'Scope 1' },
        ],
      }
      const result = normalizeChatContent(obj)
      expect(result).toContain('**1. Tarefa 1**')
    })
  })

  describe('array de blocos (formato Console)', () => {
    it('extrai texto de blocos de texto', () => {
      const blocks = [
        { type: 'text', text: 'Primeiro parágrafo' },
        { type: 'text', text: 'Segundo parágrafo' },
      ]
      const result = normalizeChatContent(blocks)
      expect(result).toBe('Primeiro parágrafo\n\nSegundo parágrafo')
    })

    it('ignora blocos de tool use/result', () => {
      const blocks = [
        { type: 'text', text: 'Texto visível' },
        { type: 'tool_use', id: 'tool_1', name: 'read', input: {} },
        { type: 'tool_result', tool_use_id: 'tool_1', content: 'resultado' },
      ]
      const result = normalizeChatContent(blocks)
      expect(result).toBe('Texto visível')
    })

    it('trata array de strings', () => {
      const blocks = ['Linha 1', 'Linha 2']
      const result = normalizeChatContent(blocks)
      expect(result).toBe('Linha 1\n\nLinha 2')
    })
  })

  describe('casos de borda', () => {
    it('não retorna [object Object]', () => {
      const obj = { foo: 'bar' }
      const result = normalizeChatContent(obj)
      expect(result).not.toContain('[object Object]')
      expect(result).toContain('Foo: bar')
    })

    it('trata perguntas vazias', () => {
      const json = JSON.stringify({ perguntas: [] })
      const result = normalizeChatContent(json)
      expect(result).toContain('O analista precisa de esclarecimentos')
    })

    it('trata subtarefas vazias', () => {
      const json = JSON.stringify({ subtarefas: [] })
      const result = normalizeChatContent(json)
      expect(result).toContain('O analista gerou um plano vazio')
    })
  })
})
