/**
 * SetupSmokeTest — Smoke test funcional obrigatório no fim do setup
 *
 * Critérios de aceite:
 * - Plano de setup inclui subtarefa obrigatória de smoke test
 * - Gate final reprova/bloqueia sem evidência de chamada HTTP bem-sucedida
 * - Vitest cobre aprovação com resposta válida e reprovação sem evidência
 */

import { describe, it, expect } from 'vitest'
import {
  isSetupTask,
  isSmokeTestSubtask,
  extractSmokeTestEvidence,
  validateSmokeTestGate,
  generateSmokeTestSubtask,
  planHasSmokeTest,
  SMOKE_TEST_SUBTASK_TITLE,
  SMOKE_TEST_ACCEPTANCE_CRITERIA,
  type SmokeTestEvidence,
} from '../src/policies/SetupSmokeTest.js'

// ─── isSetupTask ────────────────────────────────────────────────────────────

describe('isSetupTask', () => {
  it('detecta tarefa de setup pelo título', () => {
    expect(isSetupTask('Setup do projeto TaQui')).toBe(true)
    expect(isSetupTask('setup-de-novo-projeto')).toBe(true)
    expect(isSetupTask('Configuração inicial do projeto')).toBe(true)
    expect(isSetupTask('Criação do projeto SistemaAdm')).toBe(true)
  })

  it('detecta tarefa de setup pela descrição', () => {
    expect(isSetupTask('Tarefa genérica', 'Fazer setup do projeto TaQui na plataforma')).toBe(true)
  })

  it('não detecta tarefa comum como setup', () => {
    expect(isSetupTask('Implementar tela de dashboard')).toBe(false)
    expect(isSetupTask('Corrigir bug no endpoint')).toBe(false)
    expect(isSetupTask('Criar schema de usuários')).toBe(false)
  })
})

// ─── isSmokeTestSubtask ─────────────────────────────────────────────────────

describe('isSmokeTestSubtask', () => {
  it('detecta subtarefa de smoke test pelo título padrão', () => {
    expect(isSmokeTestSubtask(SMOKE_TEST_SUBTASK_TITLE)).toBe(true)
  })

  it('detecta variações do título', () => {
    expect(isSmokeTestSubtask('Smoke Test do Projeto')).toBe(true)
    expect(isSmokeTestSubtask('smoke-test funcional')).toBe(true)
    expect(isSmokeTestSubtask('Teste funcional do endpoint')).toBe(true)
  })

  it('não detecta subtarefa comum como smoke test', () => {
    expect(isSmokeTestSubtask('Criar schema do banco')).toBe(false)
    expect(isSmokeTestSubtask('Implementar CRUD de itens')).toBe(false)
    expect(isSmokeTestSubtask('Configurar migrations')).toBe(false)
  })
})

// ─── extractSmokeTestEvidence ───────────────────────────────────────────────

describe('extractSmokeTestEvidence', () => {
  it('extrai evidência válida de resultado com JSON completo', () => {
    const result = JSON.stringify({
      status: 'done',
      summary: 'Smoke test OK',
      smoke_test: {
        url: 'http://localhost:3000/api/taqui/items',
        method: 'GET',
        status: 200,
        response_body: '{"items":[]}',
        timestamp: '2026-09-03T12:00:00Z',
      },
    })

    const validation = extractSmokeTestEvidence(result)
    expect(validation.ok).toBe(true)
    if (validation.ok) {
      expect(validation.evidence.url).toBe('http://localhost:3000/api/taqui/items')
      expect(validation.evidence.method).toBe('GET')
      expect(validation.evidence.status).toBe(200)
      expect(validation.evidence.response_body).toBe('{"items":[]}')
      expect(validation.evidence.timestamp).toBe('2026-09-03T12:00:00Z')
    }
  })

  it('extrai evidência de JSON embebido em texto', () => {
    const result = `
      Smoke test executado com sucesso.
      {"smoke_test":{"url":"http://localhost:3000/api/taqui/items","method":"GET","status":200,"response_body":"OK","timestamp":"2026-09-03T12:00:00Z"}}
      Projeto respondendo normalmente.
    `

    const validation = extractSmokeTestEvidence(result)
    expect(validation.ok).toBe(true)
  })

  it('reprova resultado vazio', () => {
    expect(extractSmokeTestEvidence(null).ok).toBe(false)
    expect(extractSmokeTestEvidence(undefined).ok).toBe(false)
    expect(extractSmokeTestEvidence('').ok).toBe(false)
  })

  it('reprova resultado sem campo smoke_test', () => {
    const result = JSON.stringify({ status: 'done', summary: 'Tudo OK' })
    const validation = extractSmokeTestEvidence(result)
    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(validation.reason).toContain('smoke_test')
    }
  })

  it('reprova smoke_test com status não-2xx', () => {
    const result = JSON.stringify({
      smoke_test: {
        url: 'http://localhost:3000/api/taqui/items',
        method: 'GET',
        status: 404,
        response_body: 'Not Found',
        timestamp: '2026-09-03T12:00:00Z',
      },
    })

    const validation = extractSmokeTestEvidence(result)
    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(validation.reason).toContain('404')
    }
  })

  it('reprova smoke_test com URL vazia', () => {
    const result = JSON.stringify({
      smoke_test: {
        url: '',
        method: 'GET',
        status: 200,
        response_body: 'OK',
        timestamp: '2026-09-03T12:00:00Z',
      },
    })

    const validation = extractSmokeTestEvidence(result)
    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(validation.reason).toContain('url')
    }
  })

  it('reprova smoke_test com method inválido', () => {
    const result = JSON.stringify({
      smoke_test: {
        url: 'http://localhost:3000/api/taqui/items',
        method: 'PATCH',
        status: 200,
        response_body: 'OK',
        timestamp: '2026-09-03T12:00:00Z',
      },
    })

    const validation = extractSmokeTestEvidence(result)
    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(validation.reason).toContain('method')
    }
  })

  it('reprova JSON inválido', () => {
    const result = '{ "smoke_test": { invalid json }'
    const validation = extractSmokeTestEvidence(result)
    expect(validation.ok).toBe(false)
  })
})

// ─── validateSmokeTestGate ──────────────────────────────────────────────────

describe('validateSmokeTestGate', () => {
  it('aprova smoke test com evidência válida', () => {
    const result = JSON.stringify({
      smoke_test: {
        url: 'http://localhost:3000/api/taqui/items',
        method: 'GET',
        status: 200,
        response_body: '{"items":[]}',
        timestamp: '2026-09-03T12:00:00Z',
      },
    })

    const validation = validateSmokeTestGate(
      SMOKE_TEST_SUBTASK_TITLE,
      result,
      'taqui',
    )
    expect(validation.ok).toBe(true)
  })

  it('reprova sem evidência de chamada HTTP', () => {
    const result = JSON.stringify({ status: 'done', summary: 'Setup concluído' })

    const validation = validateSmokeTestGate(
      SMOKE_TEST_SUBTASK_TITLE,
      result,
      'taqui',
    )
    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(validation.reason).toContain('smoke_test')
    }
  })

  it('reprova quando URL não aponta para o projeto novo', () => {
    const result = JSON.stringify({
      smoke_test: {
        url: 'http://localhost:3000/api/biblioteca/items',
        method: 'GET',
        status: 200,
        response_body: 'OK',
        timestamp: '2026-09-03T12:00:00Z',
      },
    })

    const validation = validateSmokeTestGate(
      SMOKE_TEST_SUBTASK_TITLE,
      result,
      'taqui',
    )
    expect(validation.ok).toBe(false)
    if (!validation.ok) {
      expect(validation.reason).toContain('taqui')
    }
  })

  it('ignora validação para subtarefa que não é smoke test', () => {
    const validation = validateSmokeTestGate(
      'Criar schema do banco',
      null,
      'taqui',
    )
    expect(validation.ok).toBe(true)
  })

  it('aprova quando projectSlug é null (sem validação de URL)', () => {
    const result = JSON.stringify({
      smoke_test: {
        url: 'http://localhost:3000/api/items',
        method: 'GET',
        status: 200,
        response_body: 'OK',
        timestamp: '2026-09-03T12:00:00Z',
      },
    })

    const validation = validateSmokeTestGate(
      SMOKE_TEST_SUBTASK_TITLE,
      result,
      null,
    )
    expect(validation.ok).toBe(true)
  })
})

// ─── generateSmokeTestSubtask ───────────────────────────────────────────────

describe('generateSmokeTestSubtask', () => {
  it('gera subtarefa com título, escopo e critérios corretos', () => {
    const subtask = generateSmokeTestSubtask(5)

    expect(subtask.seq).toBe(5)
    expect(subtask.titulo).toBe(SMOKE_TEST_SUBTASK_TITLE)
    expect(subtask.scope).toContain('chamada HTTP real')
    expect(subtask.scope).toContain('smoke_test')
    expect(subtask.acceptance_criteria).toEqual(SMOKE_TEST_ACCEPTANCE_CRITERIA)
  })

  it('critérios incluem chamada HTTP com sucesso', () => {
    const subtask = generateSmokeTestSubtask(1)
    expect(subtask.acceptance_criteria.some(c => c.includes('2xx'))).toBe(true)
  })
})

// ─── planHasSmokeTest ───────────────────────────────────────────────────────

describe('planHasSmokeTest', () => {
  it('detecta plano com smoke test', () => {
    const subtasks = [
      { titulo: 'Criar schema' },
      { titulo: 'Configurar migrations' },
      { titulo: SMOKE_TEST_SUBTASK_TITLE },
    ]
    expect(planHasSmokeTest(subtasks)).toBe(true)
  })

  it('detecta plano sem smoke test', () => {
    const subtasks = [
      { titulo: 'Criar schema' },
      { titulo: 'Configurar migrations' },
    ]
    expect(planHasSmokeTest(subtasks)).toBe(false)
  })

  it('detecta smoke test com título variante', () => {
    const subtasks = [
      { titulo: 'Smoke Test do Projeto' },
    ]
    expect(planHasSmokeTest(subtasks)).toBe(true)
  })
})
