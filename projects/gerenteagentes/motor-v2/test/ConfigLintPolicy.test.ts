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
  parseRegistryFile,
  readComponentIdFromScreenFile,
  validateCustomScreenRegistry,
  type ConfigLintIssue,
  type RegistryIssue,
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

// ─── hasCustomScreenImplementation (legada, mantida para compat) ────────────

describe('hasCustomScreenImplementation', () => {
  const testDir = join(process.cwd(), '.test-config-lint-legacy-' + Date.now())

  beforeEach(() => {
    mkdirSync(join(testDir, 'projects', 'taqui', 'screens'), { recursive: true })
    writeFileSync(
      join(testDir, 'projects', 'taqui', 'screens', 'taqui-registro-encomenda.tsx'),
      'export default function TaquiRegistroEncomenda() { return null }',
    )
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('encontra implementação com nome exato (case-insensitive)', () => {
    expect(hasCustomScreenImplementation(testDir, 'taqui', 'taqui-registro-encomenda')).toBe(true)
  })

  it('retorna false quando não existe implementação', () => {
    expect(hasCustomScreenImplementation(testDir, 'taqui', 'tela-inexistente')).toBe(false)
  })
})

// ─── parseRegistryFile ──────────────────────────────────────────────────────

describe('parseRegistryFile', () => {
  it('extrai imports com componentId alias', () => {
    const content = `
import PainelPortariaScreen, { componentId as painelId } from "./PainelPortariaScreen"
import NotificacoesMoradorScreen, { componentId as notifId } from "./NotificacoesMoradorScreen"

export const customScreens = {
  [painelId]: PainelPortariaScreen,
  [notifId]: NotificacoesMoradorScreen,
}
`
    const parsed = parseRegistryFile(content)
    expect(parsed.imports).toHaveLength(2)
    expect(parsed.imports[0].defaultImportName).toBe('PainelPortariaScreen')
    expect(parsed.imports[0].componentIdAlias).toBe('painelId')
    expect(parsed.imports[0].importPath).toBe('./PainelPortariaScreen')
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.entries[0].componentIdRef).toBe('painelId')
    expect(parsed.entries[0].componentNameRef).toBe('PainelPortariaScreen')
  })

  it('retorna vazio para registry sem imports', () => {
    const parsed = parseRegistryFile('export const customScreens = {}')
    expect(parsed.imports).toHaveLength(0)
    expect(parsed.entries).toHaveLength(0)
  })
})

// ─── readComponentIdFromScreenFile ──────────────────────────────────────────

describe('readComponentIdFromScreenFile', () => {
  const testDir = join(process.cwd(), '.test-read-componentid-' + Date.now())

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('lê componentId exportado com aspas duplas', () => {
    const filePath = join(testDir, 'Screen.tsx')
    writeFileSync(filePath, 'export const componentId = "taqui-painel-portaria"')
    expect(readComponentIdFromScreenFile(filePath)).toBe('taqui-painel-portaria')
  })

  it('lê componentId exportado com aspas simples', () => {
    const filePath = join(testDir, 'Screen.tsx')
    writeFileSync(filePath, "export const componentId = 'taqui-notif'")
    expect(readComponentIdFromScreenFile(filePath)).toBe('taqui-notif')
  })

  it('retorna null quando arquivo não exporta componentId', () => {
    const filePath = join(testDir, 'Screen.tsx')
    writeFileSync(filePath, 'export default function Screen() { return null }')
    expect(readComponentIdFromScreenFile(filePath)).toBeNull()
  })

  it('retorna null quando arquivo não existe', () => {
    expect(readComponentIdFromScreenFile(join(testDir, 'inexistente.tsx'))).toBeNull()
  })
})

// ─── validateCustomScreenRegistry ───────────────────────────────────────────

describe('validateCustomScreenRegistry', () => {
  const testDir = join(process.cwd(), '.test-registry-validation-' + Date.now())

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  function setupValidProject() {
    const screensDir = join(testDir, 'projects', 'taqui', 'screens')
    mkdirSync(screensDir, { recursive: true })

    // Tela com componentId correto
    writeFileSync(
      join(screensDir, 'PainelPortariaScreen.tsx'),
      `export const componentId = "taqui-painel-portaria"\nexport default function PainelPortariaScreen() { return null }`,
    )

    // Registry correto
    writeFileSync(
      join(screensDir, 'registry.ts'),
      `import PainelPortariaScreen, { componentId as painelId } from "./PainelPortariaScreen"

export const customScreens = {
  [painelId]: PainelPortariaScreen,
}`,
    )
  }

  it('registry ausente falha com caminho esperado', () => {
    mkdirSync(join(testDir, 'projects', 'taqui', 'screens'), { recursive: true })
    // Sem registry.ts
    const config = `screen: { kind: "custom", componentId: "taqui-painel-portaria" }`
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0].kind).toBe('registry-missing')
    expect(issues[0].registryPath).toContain('registry.ts')
    expect(issues[0].message).toContain('projects/taqui/screens/registry.ts')
  })

  it('tela declarada no config sem entrada no registry falha', () => {
    const screensDir = join(testDir, 'projects', 'taqui', 'screens')
    mkdirSync(screensDir, { recursive: true })
    // Registry vazio
    writeFileSync(join(screensDir, 'registry.ts'), 'export const customScreens = {}')

    const config = `screen: { kind: "custom", componentId: "taqui-painel-portaria" }`
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues.length).toBe(1)
    expect(issues[0].kind).toBe('not-registered')
    expect(issues[0].componentId).toBe('taqui-painel-portaria')
    expect(issues[0].message).toContain('registry.ts')
  })

  it('entrada sem arquivo importado existente falha', () => {
    const screensDir = join(testDir, 'projects', 'taqui', 'screens')
    mkdirSync(screensDir, { recursive: true })
    // Registry importa arquivo que não existe
    writeFileSync(
      join(screensDir, 'registry.ts'),
      `import PainelScreen, { componentId as painelId } from "./PainelPortariaScreen"

export const customScreens = {
  [painelId]: PainelScreen,
}`,
    )

    const config = `screen: { kind: "custom", componentId: "taqui-painel-portaria" }`
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues.length).toBeGreaterThan(0)
    // O arquivo não existe, então não encontra nenhum import com componentId matching
    // Resulta em not-registered (não encontrou alias com componentId correto)
    expect(issues.some(i => i.kind === 'not-registered' || i.kind === 'import-missing')).toBe(true)
  })

  it('arquivo de tela sem export componentId falha', () => {
    const screensDir = join(testDir, 'projects', 'taqui', 'screens')
    mkdirSync(screensDir, { recursive: true })

    // Tela sem export componentId
    writeFileSync(
      join(screensDir, 'PainelPortariaScreen.tsx'),
      `export default function PainelPortariaScreen() { return null }`,
    )

    // Registry importa a tela
    writeFileSync(
      join(screensDir, 'registry.ts'),
      `import PainelPortariaScreen, { componentId as painelId } from "./PainelPortariaScreen"

export const customScreens = {
  [painelId]: PainelPortariaScreen,
}`,
    )

    const config = `screen: { kind: "custom", componentId: "taqui-painel-portaria" }`
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues.length).toBe(1)
    expect(issues[0].kind).toBe('not-registered')
    // Não encontra porque o arquivo não exporta componentId
  })

  it('arquivo com componentId divergente do config falha', () => {
    const screensDir = join(testDir, 'projects', 'taqui', 'screens')
    mkdirSync(screensDir, { recursive: true })

    // Tela com componentId diferente do esperado
    writeFileSync(
      join(screensDir, 'PainelPortariaScreen.tsx'),
      `export const componentId = "taqui-painel-antigo"\nexport default function PainelPortariaScreen() { return null }`,
    )

    writeFileSync(
      join(screensDir, 'registry.ts'),
      `import PainelPortariaScreen, { componentId as painelId } from "./PainelPortariaScreen"

export const customScreens = {
  [painelId]: PainelPortariaScreen,
}`,
    )

    const config = `screen: { kind: "custom", componentId: "taqui-painel-portaria" }`
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues.length).toBe(1)
    expect(issues[0].kind).toBe('not-registered')
    // O componentId exportado ("taqui-painel-antigo") não bate com o config ("taqui-painel-portaria")
  })

  it('cada componentId declarado no config resolve a uma implementação registrada', () => {
    setupValidProject()

    const config = `screen: { kind: "custom", componentId: "taqui-painel-portaria" }`
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues).toHaveLength(0)
  })

  it('múltiplas telas: todas registradas = zero issues', () => {
    const screensDir = join(testDir, 'projects', 'taqui', 'screens')
    mkdirSync(screensDir, { recursive: true })

    writeFileSync(
      join(screensDir, 'PainelPortariaScreen.tsx'),
      `export const componentId = "taqui-painel-portaria"\nexport default function() { return null }`,
    )
    writeFileSync(
      join(screensDir, 'NotificacoesScreen.tsx'),
      `export const componentId = "taqui-notificacoes"\nexport default function() { return null }`,
    )

    writeFileSync(
      join(screensDir, 'registry.ts'),
      `import PainelPortariaScreen, { componentId as painelId } from "./PainelPortariaScreen"
import NotificacoesScreen, { componentId as notifId } from "./NotificacoesScreen"

export const customScreens = {
  [painelId]: PainelPortariaScreen,
  [notifId]: NotificacoesScreen,
}`,
    )

    const config = `
      items: [
        { screen: { kind: "custom", componentId: "taqui-painel-portaria" } },
        { screen: { kind: "custom", componentId: "taqui-notificacoes" } },
      ]
    `
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues).toHaveLength(0)
  })

  it('múltiplas telas: uma faltando = issue para a faltante', () => {
    const screensDir = join(testDir, 'projects', 'taqui', 'screens')
    mkdirSync(screensDir, { recursive: true })

    writeFileSync(
      join(screensDir, 'PainelPortariaScreen.tsx'),
      `export const componentId = "taqui-painel-portaria"\nexport default function() { return null }`,
    )

    writeFileSync(
      join(screensDir, 'registry.ts'),
      `import PainelPortariaScreen, { componentId as painelId } from "./PainelPortariaScreen"

export const customScreens = {
  [painelId]: PainelPortariaScreen,
}`,
    )

    const config = `
      items: [
        { screen: { kind: "custom", componentId: "taqui-painel-portaria" } },
        { screen: { kind: "custom", componentId: "taqui-entrega-encomenda" } },
      ]
    `
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues).toHaveLength(1)
    expect(issues[0].componentId).toBe('taqui-entrega-encomenda')
    expect(issues[0].kind).toBe('not-registered')
  })

  it('componentId duplicado no config gera issue', () => {
    setupValidProject()

    const config = `
      items: [
        { screen: { kind: "custom", componentId: "taqui-painel-portaria" } },
        { screen: { kind: "custom", componentId: "taqui-painel-portaria" } },
      ]
    `
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues.some(i => i.kind === 'duplicate-componentId')).toBe(true)
  })

  it('config sem telas custom e sem registry = zero issues', () => {
    mkdirSync(join(testDir, 'projects', 'taqui'), { recursive: true })
    const config = `screen: { kind: "cadastro", resource: "condominios" }`
    const issues = validateCustomScreenRegistry(testDir, 'taqui', config)
    expect(issues).toHaveLength(0)
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

  it('reprova quando tela custom não tem registro (registry ausente)', () => {
    // Remove o registry se existir
    const config = `
      screen: { kind: "custom", componentId: "taqui-painel-portaria" }
    `
    const result = validateCompleteness(testDir, 'taqui', config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing.some(m => m.kind === 'custom-screen' && m.identifier === 'taqui-painel-portaria')).toBe(true)
    }
  })

  it('aprova quando tela custom tem registro correto', () => {
    // Cria registry com tela registrada
    const screensDir = join(testDir, 'projects', 'taqui', 'screens')
    writeFileSync(
      join(screensDir, 'RegistroEncomendaScreen.tsx'),
      `export const componentId = "taqui-registro-encomenda"\nexport default function() { return null }`,
    )
    writeFileSync(
      join(screensDir, 'registry.ts'),
      `import RegistroEncomendaScreen, { componentId as registroId } from "./RegistroEncomendaScreen"

export const customScreens = {
  [registroId]: RegistroEncomendaScreen,
}`,
    )

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
