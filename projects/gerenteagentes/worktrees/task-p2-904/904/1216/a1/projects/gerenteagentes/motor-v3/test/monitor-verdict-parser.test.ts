import { describe, expect, it } from 'vitest'
import { parseMonitorVerdict } from '../src/monitor/index.js'

const RESPOSTA_COMPLETA = `
STATUS: RESOLVIDO
ORIGEM: MOTOR

CAUSA:
Migration 0005 com sintaxe inválida para PREPARE.

CORREÇÃO:
Reescrita da migration na branch motor-v3-fix/migration-0005, commit abc1234.

VALIDAÇÃO:
npx drizzle-kit migrate → [✓] migrations applied successfully!

DEPLOY:
deploy.sh executado — ativo=green.

RETOMADA:
Motor com código novo retoma o deploy da tarefa automaticamente.

MENSAGEM_CHAT:
O deploy falhou por um erro de sintaxe na migration 0005. Corrigi o motor, mergeei na base e refiz o deploy. A tarefa segue seu curso.
`

describe('parseMonitorVerdict', () => {
  it('extrai todos os campos de uma resposta completa', () => {
    const verdict = parseMonitorVerdict(RESPOSTA_COMPLETA)

    expect(verdict.parseable).toBe(true)
    expect(verdict.status).toBe('RESOLVIDO')
    expect(verdict.origin).toBe('MOTOR')
    expect(verdict.cause).toContain('Migration 0005 com sintaxe inválida')
    expect(verdict.correction).toContain('motor-v3-fix/migration-0005')
    expect(verdict.validation).toContain('drizzle-kit migrate')
    expect(verdict.deploy).toContain('ativo=green')
    expect(verdict.resumption).toContain('retoma o deploy')
    expect(verdict.chatMessage).toContain('erro de sintaxe na migration 0005')
    expect(verdict.raw).toBe(RESPOSTA_COMPLETA)
  })

  it('não confunde PARCIALMENTE_RESOLVIDO nem NAO_RESOLVIDO com RESOLVIDO', () => {
    expect(parseMonitorVerdict('STATUS: PARCIALMENTE_RESOLVIDO\nORIGEM: DEV').status).toBe('PARCIALMENTE_RESOLVIDO')
    expect(parseMonitorVerdict('STATUS: NAO_RESOLVIDO\nORIGEM: EXTERNO').status).toBe('NAO_RESOLVIDO')
    expect(parseMonitorVerdict('STATUS: RESOLVIDO').status).toBe('RESOLVIDO')
  })

  it('aceita headers sem acento e em outra caixa', () => {
    const verdict = parseMonitorVerdict([
      'status: RESOLVIDO',
      'origem: TESTES_DEV',
      'correcao: ajustei o suite',
      'validacao: vitest 10/10',
      'mensagem_chat: testes corrigidos',
    ].join('\n'))

    expect(verdict.status).toBe('RESOLVIDO')
    expect(verdict.origin).toBe('TESTES_DEV')
    expect(verdict.correction).toBe('ajustei o suite')
    expect(verdict.validation).toBe('vitest 10/10')
    expect(verdict.chatMessage).toBe('testes corrigidos')
  })

  it('aceita resposta envolta em cerca de código e com texto extra', () => {
    const verdict = parseMonitorVerdict([
      'Análise concluída. Segue o veredito:',
      '```',
      'STATUS: RESOLVIDO',
      'ORIGEM: DEV',
      'CAUSA: import errado',
      'MENSAGEM_CHAT: corrigi o import',
      '```',
      'Fim.',
    ].join('\n'))

    expect(verdict.status).toBe('RESOLVIDO')
    expect(verdict.origin).toBe('DEV')
    expect(verdict.cause).toBe('import errado')
  })

  it('sintetiza mensagem de chat quando MENSAGEM_CHAT está ausente', () => {
    const verdict = parseMonitorVerdict([
      'STATUS: RESOLVIDO',
      'ORIGEM: DEV',
      'CAUSA: import errado no módulo X',
      'CORREÇÃO: import corrigido, commit def456',
      'VALIDAÇÃO: testes 10/10',
    ].join('\n'))

    expect(verdict.chatMessage).toContain('origem como DEV')
    expect(verdict.chatMessage).toContain('import errado no módulo X')
    expect(verdict.chatMessage).toContain('Bloqueio resolvido')
  })

  it('resposta sem STATUS é não parseável e conserva bloqueio (NAO_RESOLVIDO)', () => {
    const verdict = parseMonitorVerdict('Acho que deu certo, segue o jogo.')

    expect(verdict.parseable).toBe(false)
    expect(verdict.status).toBe('NAO_RESOLVIDO')
    expect(verdict.origin).toBe('DESCONHECIDA')
    expect(verdict.chatMessage).toContain('não seguiu o contrato de veredito')
  })

  it('ORIGEM desconhecida vira DESCONHECIDA sem quebrar o parse', () => {
    const verdict = parseMonitorVerdict('STATUS: NAO_RESOLVIDO\nORIGEM: INDEFINIDA')

    expect(verdict.parseable).toBe(true)
    expect(verdict.origin).toBe('DESCONHECIDA')
  })

  it('ignora linhas STATUS/ORIGEM repetidas dentro de seções', () => {
    const verdict = parseMonitorVerdict([
      'STATUS: RESOLVIDO',
      'ORIGEM: MOTOR',
      'CAUSA: falha no motor',
      'MENSAGEM_CHAT: exemplo STATUS: NAO_RESOLVIDO dentro do texto',
    ].join('\n'))

    expect(verdict.status).toBe('RESOLVIDO')
    expect(verdict.chatMessage).toContain('dentro do texto')
  })
})
