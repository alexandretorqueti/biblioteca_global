/**
 * GateScopePolicy — gate escopado por subtarefa (2026-08-31, Alexandre).
 * A suíte completa só roda com alteração transversal; caso contrário apenas
 * os testes afetados (ou nenhum), para que testes flaky/alheios não reprovem
 * entregas simples como "criar config.json".
 */

import { describe, it, expect } from 'vitest'
import { decideGateScope, affectedTestFiles, isTestPath, isRiskyChange } from '../src/policies/GateScopePolicy.js'

describe('GateScopePolicy', () => {
  const allTests = [
    'projects/gerenteagentes/screens/__tests__/NovaTarefaScreen.test.tsx',
    'projects/gerenteagentes/screens/__tests__/TaskMonitorScreen.test.tsx',
    'projects/gerenteagentes/motor-v2/test/TaskCoordinator.test.ts',
    'apps/api/src/modules/auth/__tests__/auth.service.spec.ts',
  ]

  it('sem alterações → pula testes', () => {
    const decision = decideGateScope([], allTests)
    expect(decision.kind).toBe('skip')
  })

  it('config.json novo (sem teste afetado) → pula testes', () => {
    const decision = decideGateScope(['projects/sistema-adm-global/config.json'], allTests)
    expect(decision.kind).toBe('skip')
  })

  it('alteração em package.json → suíte cheia', () => {
    const decision = decideGateScope(['package.json'], allTests)
    expect(decision.kind).toBe('full')
  })

  it('alteração em vitest.config.ts da RAIZ → suíte cheia', () => {
    const decision = decideGateScope(['vitest.config.ts'], allTests)
    expect(decision.kind).toBe('full')
  })

  it('B10: vitest.config.ts de um projeto → escopo do projeto, não suíte cheia', () => {
    const decision = decideGateScope(['projects/gerenteagentes/motor-v2/vitest.config.ts'], allTests)
    expect(decision.kind).toBe('scoped')
    if (decision.kind === 'scoped') {
      expect(decision.files).toContain('projects/gerenteagentes/motor-v2/test/TaskCoordinator.test.ts')
      expect(decision.files).not.toContain('apps/api/src/modules/auth/__tests__/auth.service.spec.ts')
    }
  })

  it('B10: drizzle.config.ts da RAIZ → suíte cheia', () => {
    const decision = decideGateScope(['drizzle.config.ts'], allTests)
    expect(decision.kind).toBe('full')
  })

  it('B10: drizzle.config.ts de projeto sem testes → pula (caso subtarefa 731)', () => {
    const decision = decideGateScope(['projects/sistema-adm-global/drizzle.config.ts'], allTests)
    expect(decision.kind).toBe('skip')
  })

  it('alteração em componente com testes sob __tests__ do mesmo diretório → escopo direcionado', () => {
    const decision = decideGateScope(['projects/gerenteagentes/screens/NovaTarefaScreen.tsx'], allTests)
    expect(decision.kind).toBe('scoped')
    if (decision.kind === 'scoped') {
      // regra de diretório: testes sob o mesmo diretório da alteração
      expect(decision.files).toContain('projects/gerenteagentes/screens/__tests__/NovaTarefaScreen.test.tsx')
      expect(decision.files).toContain('projects/gerenteagentes/screens/__tests__/TaskMonitorScreen.test.tsx')
      expect(decision.files).not.toContain('projects/gerenteagentes/motor-v2/test/TaskCoordinator.test.ts')
    }
  })

  it('alteração no próprio arquivo de teste → roda ele mesmo', () => {
    const decision = decideGateScope(['apps/api/src/modules/auth/__tests__/auth.service.spec.ts'], allTests)
    expect(decision.kind).toBe('scoped')
    if (decision.kind === 'scoped') {
      expect(decision.files).toEqual(['apps/api/src/modules/auth/__tests__/auth.service.spec.ts'])
    }
  })

  it('alteração em diretório com testes dentro → roda os testes do diretório', () => {
    const decision = decideGateScope(['projects/gerenteagentes/screens/IsaChat.css'], allTests)
    expect(decision.kind).toBe('scoped')
    if (decision.kind === 'scoped') {
      expect(decision.files).toContain('projects/gerenteagentes/screens/__tests__/NovaTarefaScreen.test.tsx')
      expect(decision.files).toContain('projects/gerenteagentes/screens/__tests__/TaskMonitorScreen.test.tsx')
    }
  })

  it('arquivo de projeto sem testes não puxa testes de outro projeto', () => {
    const decision = decideGateScope(['projects/sistema-adm-global/src/App.tsx'], allTests)
    expect(decision.kind).toBe('skip')
  })

  it('isTestPath reconhece diretórios e sufixos de teste', () => {
    expect(isTestPath('a/test/x.ts')).toBe(true)
    expect(isTestPath('a/__tests__/x.ts')).toBe(true)
    expect(isTestPath('a/x.spec.ts')).toBe(true)
    expect(isTestPath('a/x.test.tsx')).toBe(true)
    expect(isTestPath('a/x.ts')).toBe(false)
  })

  it('isRiskyChange cobre lock/config transversais da RAIZ', () => {
    expect(isRiskyChange('package-lock.json')).toBe(true)
    expect(isRiskyChange('tsconfig.base.json')).toBe(true)
    expect(isRiskyChange('drizzle.config.ts')).toBe(true)
    // B10: config aninhada (de projeto/app) não é transversal
    expect(isRiskyChange('apps/web/tsconfig.json')).toBe(false)
    expect(isRiskyChange('projects/sistema-adm-global/drizzle.config.ts')).toBe(false)
    expect(isRiskyChange('apps/web/src/main.tsx')).toBe(false)
  })

  it('affectedTestFiles deduplica e ordena', () => {
    const files = affectedTestFiles(
      ['projects/gerenteagentes/screens/NovaTarefaScreen.tsx', 'projects/gerenteagentes/screens/DashboardScreen.tsx'],
      allTests,
    )
    expect(files).toEqual(['projects/gerenteagentes/screens/__tests__/NovaTarefaScreen.test.tsx', 'projects/gerenteagentes/screens/__tests__/TaskMonitorScreen.test.tsx'])
  })
})
