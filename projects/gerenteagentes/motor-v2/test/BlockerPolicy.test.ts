import { describe, expect, it } from 'vitest'
import { blockerEvidence, classifySystemicFailure } from '../src/policies/BlockerPolicy.js'

describe('BlockerPolicy', () => {
  it('classifica falha de repositório e mantém o fingerprint original', () => {
    expect(blockerEvidence('systemic_failure', 'Repositório principal não está limpo')).toEqual({
      kind: 'systemic_failure',
      category: 'repo_dirty',
      fingerprint: 'repositório principal não está limpo',
      excerpt: '[repo_dirty] limpar o repositório de execução antes de tentar novamente — Repositório principal não está limpo',
    })
  })

  it('direciona categorias conhecidas e usa diagnóstico interno como fallback', () => {
    expect(classifySystemicFailure('pré-verificação do Git falhou')).toBe('git_preflight')
    expect(classifySystemicFailure('subtarefa sem evidência obrigatória')).toBe('missing_evidence')
    expect(classifySystemicFailure('cadeia de modelos indisponível')).toBe('model_chain')
    expect(classifySystemicFailure('falha sistêmica repetida entre modelos')).toBe('model_chain')
    expect(classifySystemicFailure('Porta 3003 ocupada pelo PID 1234')).toBe('motor_internal')
  })

  it('não altera evidências de bloqueios que não são sistêmicos', () => {
    expect(blockerEvidence('blocked_environment', 'Porta 3003 ocupada pelo PID 1234')).toEqual({
      kind: 'blocked_environment',
      fingerprint: 'porta <n> ocupada pelo pid <n>',
      excerpt: 'Porta 3003 ocupada pelo PID 1234',
    })
  })
})
