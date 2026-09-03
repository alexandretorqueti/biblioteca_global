/**
 * ConfigLintPolicy — Lint de config.ts e validação de completude
 *
 * Critérios de aceite:
 * - FK number sem multipleChoice e componentId não registrado reprovam com diagnóstico claro
 * - Declarações do config sem implementação correspondente reprovam o gate com lista de pendências
 * - Vitest cobre cada regra de lint e de completude
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  lintFkNumberWithoutMultipleChoice,
  extractCustomScreenComponentIds,
  extractActions,
  hasCustomScreenImplementation,
  hasActionImplementation,
  lintConfig,
  validateCompleteness,
  validateProjectConfig,
  formatConfigValidationReport,
  readProjectConfig,
  type ConfigLintIssue,
} from '../src/policies/ConfigLintPolicy.js'

// ─── lintFkNumberWithoutMultipleChoice ──────────────────────────────────────

describe('lintFkNumberWithoutMultipleChoice', () => {
  it('reprova campo FK com type number sem multipleChoice', () => {
    const config = `
      fields: [
        { name: "condominioId", label: "Condomínio", type: "number", required: true },
      ]
    `
    const issues = lintFkNumberWithoutMultipleChoice(config)
    expect(issues.length).toBe(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].rule).toBe('fk-number-without-multiple-choice')
    expect(issues[0].message).toContain('condominioId')
    expect(issues[0].message).toContain('multipleChoice')
  })

  it('aprova campo FK com type multipleChoice', () => {
    const config = `
      fields: [
        { name: "condominioId", label: "Condomínio", type: "multipleChoice", multipleChoice: { resource: "condominios", idField: "id", displayField: "nome" }, required: true },
      ]
    `
    const issues = lintFkNumberWithoutMultipleChoice(config)
    expect(issues.length).toBe(0)
  })

  it('aprova campo type number que NÃO é FK (não termina em Id)', () => {
    const config = `
      fields: [
        { name: "andar", label: "Andar", type: "number" },
        { name: "quantidade", label: "Quantidade", type: "number" },
      ]
    `
    const issues = lintFkNumberWithoutMultipleChoice(config)
    expect(issues.length).toBe(0)
  })

  it('detecta múltiplos campos FK problemáticos', () => {
    const config = `
      fields: [
        { name: "condominioId", label: "Condomínio", type: "number" },
        { name: "unidadeId", label: "Unidade", type: "number" },
        { name: "andar", label: "Andar", type: "number" },
      ]
    `
    const issues = lintFkNumberWithoutMultipleChoice(config)
    expect(issues.length).toBe(2)
    expect(issues.map(i => i.path)).toContain('field "condominioId"')
    expect(issues.map(i => i.path)).toContain('field "unidadeId"')
  })

  it('detecta padrão snake_case (_id)', () => {
    const config = `
      fields: [
        { name: "condominio_id", label: "Condomínio", type: "number" },
      ]
    `
    const issues = lintFkNumberWithoutMultipleChoice(config)
    expect(issues.length).toBe(1)
    expect(issues[0].rule).toBe('fk-number-without-multiple-choice')
  })

  it('aprova campo FK number com multipleChoice no mesmo bloco', () => {
    const config = `
      fields: [
        { name: "proprietarioId", label: "Proprietário", type: "multipleChoice", multipleChoice: { resource: "proprietarios", idField: "id", displayField: "nome" } },
      ]
    `
    const issues = lintFkNumberWithoutMultipleChoice(config)
    expect(issues.length).toBe(0)
  })

  it('retorna vazio para config sem campos', () => {
    const config = `export const config = { app: { name: "Test" } }`
    const issues = lintFkNumberWithoutMultipleChoice(config)
    expect(issues.length).toBe(0)
  })
})

// ─── extractCustomScreenComponentIds ────────────────────────────────────────

describe('extractCustomScreenComponentIds', () => {
  it('extrai componentId de tela custom (kind antes de componentId)', () => {
    const config = `
      screen: {
        kind: "custom",
        componentId: "taqui-registro-encomenda",
      }
    `
    const results = extractCustomScreenComponentIds(config)
    expect(results.length).toBe(1)
    expect(results[0].componentId).toBe('taqui-registro-encomenda')
  })

  it('extrai múltiplos componentIds', () => {
    const config = `
      items: [
        { screen: { kind: "custom", componentId: "taqui-registro-encomenda" } },
        { screen: { kind: "custom", componentId: "taqui-painel-portaria" } },
        { screen: { kind: "cadastro", resource: "condominios" } },
      ]
    `
    const results = extractCustomScreenComponentIds(config)
    expect(results.length).toBe(2)
    expect(results.map(r => r.componentId)).toContain('taqui-registro-encomenda')
    expect(results.map(r => r.componentId)).toContain('taqui-painel-portaria')
  })

  it('não extrai componentId de tela cadastro', () => {
    const config = `
      screen: {
        kind: "cadastro",
        resource: "condominios",
      }
    `
    const results = extractCustomScreenComponentIds(config)
    expect(results.length).toBe(0)
  })

  it('retorna vazio para config sem telas custom', () => {
    const config = `export const config = { app: { name: "Test" } }`
    const results = extractCustomScreenComponentIds(config)
    expect(results.length).toBe(0)
  })
})

// ─── extractActions ─────────────────────────────────────────────────────────

describe('extractActions', () => {
  it('extrai actions com id, method e path', () => {
    const config = `
      rowActions: [
        { id: "confirmar", label: "Confirmar", method: "POST", path: "/api/taqui/encomendas/:id/confirmar" },
      ]
    `
    const results = extractActions(config)
    expect(results.length).toBe(1)
    expect(results[0].actionId).toBe('confirmar')
    expect(results[0].method).toBe('POST')
    expect(results[0].actionPath).toBe('/api/taqui/encomendas/:id/confirmar')
  })

  it('extrai múltiplas actions', () => {
    const config = `
      actions: [
        { id: "exportar", label: "Exportar", method: "GET", path: "/api/taqui/export" },
      ],
      rowActions: [
        { id: "confirmar", label: "Confirmar", method: "POST", path: "/api/taqui/:id/confirmar" },
        { id: "cancelar", label: "Cancelar", method: "DELETE", path: "/api/taqui/:id" },
      ]
    `
    const results = extractActions(config)
    expect(results.length).toBe(3)
  })

  it('retorna vazio para config sem actions', () => {
    const config = `export const config = { app: { name: "Test" } }`
    const results = extractActions(config)
    expect(results.length).toBe(0)
  })
})

// ─── hasCustomScreenImplementation ──────────────────────────────────────────

describe('hasCustomScreenImplementation', () => {
  const testDir = join(process.cwd(), '.test-config-lint-' + Date.now())

  beforeEach(() => {
    mkdirSync(join(testDir, 'projects', 'taqui', 'screens'), { recursive: true })
    writeFileSync(
      join(testDir, 'projects', 'taqui', 'screens', 'taqui-registro-encomenda.tsx'),
      'export default function TaquiRegistroEncomenda() { return null }',
    )
    writeFileSync(
      join(testDir, 'projects', 'taqui', 'screens', 'painel-portaria.tsx'),
      'export default function PainelPortaria() { return null }',
    )
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('encontra implementação com nome exato (case-insensitive)', () => {
    // O arquivo é taqui-registro-encomenda.tsx, busca por taqui-registro-encomenda
    expect(hasCustomScreenImplementation(testDir, 'taqui', 'taqui-registro-encomenda')).toBe(true)
  })

  it('encontra implementação com nome parcial', () => {
    expect(hasCustomScreenImplementation(testDir, 'taqui', 'painel-portaria')).toBe(true)
  })

  it('retorna false quando não existe implementação', () => {
    expect(hasCustomScreenImplementation(testDir, 'taqui', 'tela-inexistente')).toBe(false)
  })

  it('retorna false quando diretório screens não existe', () => {
    expect(hasCustomScreenImplementation(testDir, 'inexistente', 'qualquer')).toBe(false)
  })
})

// ─── hasActionImplementation ────────────────────────────────────────────────

describe('hasActionImplementation', () => {
  const testDir = join(process.cwd(), '.test-config-lint-actions-' + Date.now())

  beforeEach(() => {
    mkdirSync(join(testDir, 'apps', 'api', 'src', 'modules'), { recursive: true })
    writeFileSync(
      join(testDir, 'apps', 'api', 'src', 'modules', 'encomendas.controller.ts'),
      `
        @Post('/api/taqui/encomendas/:id/confirmar')
        async confirmarEncomenda() { }
      `,
    )
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('encontra implementação do endpoint', () => {
    expect(hasActionImplementation(testDir, '/api/taqui/encomendas/:id/confirmar')).toBe(true)
  })

  it('retorna false quando endpoint não existe', () => {
    expect(hasActionImplementation(testDir, '/api/taqui/inexistente')).toBe(false)
  })
})

// ─── lintConfig ─────────────────────────────────────────────────────────────

describe('lintConfig', () => {
  it('reprova config com FK number sem multipleChoice', () => {
    const config = `
      export const config = {
        groups: [{
          items: [{
            screen: {
              kind: "cadastro",
              fields: [
                { name: "condominioId", label: "Condomínio", type: "number" },
              ]
            }
          }]
        }]
      }
    `
    const result = lintConfig(config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.summary).toContain('falhou')
    }
    expect(result.issues.some(i => i.rule === 'fk-number-without-multiple-choice')).toBe(true)
  })

  it('aprova config sem problemas', () => {
    const config = `
      export const config = {
        groups: [{
          items: [{
            screen: {
              kind: "cadastro",
              fields: [
                { name: "andar", label: "Andar", type: "number" },
                { name: "condominioId", type: "multipleChoice", multipleChoice: { resource: "condominios" } },
              ]
            }
          }]
        }]
      }
    `
    const result = lintConfig(config)
    expect(result.ok).toBe(true)
  })

  it('emite warning para componentId fora do padrão kebab-case', () => {
    const config = `
      screen: {
        kind: "custom",
        componentId: "TaquiRegistroEncomenda",
      }
    `
    const result = lintConfig(config)
    expect(result.issues.some(i => i.rule === 'component-id-format' && i.severity === 'warning')).toBe(true)
  })
})

// ─── validateCompleteness ───────────────────────────────────────────────────

describe('validateCompleteness', () => {
  const testDir = join(process.cwd(), '.test-config-lint-completeness-' + Date.now())

  beforeEach(() => {
    mkdirSync(join(testDir, 'projects', 'taqui', 'screens'), { recursive: true })
    writeFileSync(
      join(testDir, 'projects', 'taqui', 'screens', 'taqui-registro-encomenda.tsx'),
      'export default function() { return null }',
    )
    mkdirSync(join(testDir, 'apps', 'api', 'src'), { recursive: true })
    writeFileSync(
      join(testDir, 'apps', 'api', 'src', 'controller.ts'),
      'Post("/api/taqui/encomendas/:id/confirmar")',
    )
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('reprova quando tela custom não tem implementação', () => {
    const config = `
      screen: { kind: "custom", componentId: "taqui-painel-portaria" }
    `
    const result = validateCompleteness(testDir, 'taqui', config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing.some(m => m.kind === 'custom-screen' && m.identifier === 'taqui-painel-portaria')).toBe(true)
      expect(result.summary).toContain('sem implementação')
    }
  })

  it('aprova quando tela custom tem implementação', () => {
    const config = `
      screen: { kind: "custom", componentId: "taqui-registro-encomenda" }
    `
    const result = validateCompleteness(testDir, 'taqui', config)
    expect(result.ok).toBe(true)
  })

  it('reprova quando action não tem implementação', () => {
    const config = `
      rowActions: [
        { id: "cancelar", label: "Cancelar", method: "DELETE", path: "/api/taqui/inexistente" },
      ]
    `
    const result = validateCompleteness(testDir, 'taqui', config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing.some(m => m.kind === 'row-action' && m.identifier === 'cancelar')).toBe(true)
    }
  })

  it('aprova quando action tem implementação', () => {
    const config = `
      rowActions: [
        { id: "confirmar", label: "Confirmar", method: "POST", path: "/api/taqui/encomendas/:id/confirmar" },
      ]
    `
    const result = validateCompleteness(testDir, 'taqui', config)
    expect(result.ok).toBe(true)
  })
})

// ─── validateProjectConfig ──────────────────────────────────────────────────

describe('validateProjectConfig', () => {
  const testDir = join(process.cwd(), '.test-config-lint-full-' + Date.now())

  beforeEach(() => {
    mkdirSync(join(testDir, 'projects', 'taqui', 'screens'), { recursive: true })
    writeFileSync(
      join(testDir, 'projects', 'taqui', 'config.ts'),
      `
        export const config = {
          groups: [{
            items: [{
              screen: {
                kind: "cadastro",
                fields: [
                  { name: "andar", label: "Andar", type: "number" },
                ]
              }
            },
            {
              screen: { kind: "custom", componentId: "taqui-painel" }
            }]
          }]
        }
      `,
    )
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('reprova quando config.ts não existe', () => {
    const result = validateProjectConfig(testDir, 'inexistente')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.summary).toContain('não encontrado')
    }
  })

  it('reprova quando há problemas de lint e completude', () => {
    // Adiciona FK problemática ao config
    writeFileSync(
      join(testDir, 'projects', 'taqui', 'config.ts'),
      `
        export const config = {
          groups: [{
            items: [{
              screen: {
                kind: "cadastro",
                fields: [
                  { name: "condominioId", label: "Condomínio", type: "number" },
                ]
              }
            },
            {
              screen: { kind: "custom", componentId: "taqui-painel" }
            }]
          }]
        }
      `,
    )

    const result = validateProjectConfig(testDir, 'taqui')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.lintIssues.some(i => i.rule === 'fk-number-without-multiple-choice')).toBe(true)
      expect(result.completenessIssues.some(m => m.kind === 'custom-screen')).toBe(true)
    }
  })
})

// ─── formatConfigValidationReport ───────────────────────────────────────────

describe('formatConfigValidationReport', () => {
  it('formata relatório de sucesso', () => {
    const result = { ok: true as const, lintIssues: [], completenessIssues: [] }
    const report = formatConfigValidationReport(result)
    expect(report).toContain('✅')
    expect(report).toContain('validado com sucesso')
  })

  it('formata relatório com erros de lint', () => {
    const result = {
      ok: false as const,
      lintIssues: [{
        severity: 'error' as const,
        rule: 'fk-number-without-multiple-choice',
        path: 'field "condominioId"',
        message: 'Campo FK "condominioId" declarado como type: "number" sem multipleChoice.',
        suggestion: 'Alterar para type: "multipleChoice"',
      }],
      completenessIssues: [],
      summary: 'Validação do config.ts falhou: 1 erro(s) de lint, 0 declaração(ões) sem implementação.',
    }
    const report = formatConfigValidationReport(result)
    expect(report).toContain('❌')
    expect(report).toContain('Erros de Lint')
    expect(report).toContain('condominioId')
    expect(report).toContain('Sugestão')
  })

  it('formata relatório com problemas de completude', () => {
    const result = {
      ok: false as const,
      lintIssues: [],
      completenessIssues: [{
        kind: 'custom-screen' as const,
        identifier: 'taqui-painel',
        path: 'screen with componentId "taqui-painel"',
        message: 'Tela custom "taqui-painel" sem implementação.',
        expectedFile: 'projects/taqui/screens/taqui-painel.tsx',
      }],
      summary: 'Validação do config.ts falhou: 0 erro(s) de lint, 1 declaração(ões) sem implementação.',
    }
    const report = formatConfigValidationReport(result)
    expect(report).toContain('❌')
    expect(report).toContain('Declarações sem Implementação')
    expect(report).toContain('taqui-painel')
    expect(report).toContain('Arquivo esperado')
  })
})

// ─── readProjectConfig ──────────────────────────────────────────────────────

describe('readProjectConfig', () => {
  const testDir = join(process.cwd(), '.test-config-lint-read-' + Date.now())

  beforeEach(() => {
    mkdirSync(join(testDir, 'projects', 'taqui'), { recursive: true })
    writeFileSync(
      join(testDir, 'projects', 'taqui', 'config.ts'),
      'export const config = { app: { name: "TaQui" } }',
    )
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('lê config.ts existente', () => {
    const content = readProjectConfig(testDir, 'taqui')
    expect(content).toContain('TaQui')
  })

  it('retorna null quando config.ts não existe', () => {
    const content = readProjectConfig(testDir, 'inexistente')
    expect(content).toBeNull()
  })
})
