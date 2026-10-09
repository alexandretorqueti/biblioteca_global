// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parsePostDeployVerdict } from '../src/monitor/index.js'

const RESPOSTA_CONSISTENTE = `
VEREDITO: CONSISTENTE

Todas as tarefas do batch foram implementadas corretamente e funcionam em produção.
Os testes são coerentes com os critérios de aceite.
`

const RESPOSTA_INCONGRUENTE = `
VEREDITO: INCONGRUENTE

## Findings

### Tarefa: task-123
- Descrição: Endpoint /api/users não retorna o campo email conforme especificado
- Evidência: GET /api/users/1 retorna {"id":1,"name":"Test"} sem campo email. Logs mostram query SQL sem JOIN com tabela emails.
- Severidade: high

### Tarefa: task-456
- Descrição: Testes não validam o critério de aceite principal
- Evidência: Testes em src/__tests__/user.test.ts verificam apenas campos básicos, não validam filtro por data conforme critério "usuários criados nos últimos 7 dias"
- Severidade: medium
`

const RESPOSTA_INCONCLUSIVO = `
Não consegui verificar os endpoints em produção. O serviço parece estar fora do ar.
`

describe('parsePostDeployVerdict', () => {
  it('extrai CONSISTENTE sem findings', () => {
    const verdict = parsePostDeployVerdict(RESPOSTA_CONSISTENTE)

    expect(verdict.parseable).toBe(true)
    expect(verdict.status).toBe('CONSISTENTE')
    expect(verdict.findings).toHaveLength(0)
    expect(verdict.raw).toBe(RESPOSTA_CONSISTENTE)
  })

  it('extrai INCONGRUENTE com findings estruturados', () => {
    const verdict = parsePostDeployVerdict(RESPOSTA_INCONGRUENTE)

    expect(verdict.parseable).toBe(true)
    expect(verdict.status).toBe('INCONGRUENTE')
    expect(verdict.findings).toHaveLength(2)

    const finding1 = verdict.findings[0]
    expect(finding1?.taskId).toBe('task-123')
    expect(finding1?.description).toContain('Endpoint /api/users não retorna o campo email')
    expect(finding1?.evidence).toContain('GET /api/users/1')
    expect(finding1?.severity).toBe('high')

    const finding2 = verdict.findings[1]
    expect(finding2?.taskId).toBe('task-456')
    expect(finding2?.severity).toBe('medium')
  })

  it('aceita resposta sem VEREDITO como INCONCLUSIVO', () => {
    const verdict = parsePostDeployVerdict(RESPOSTA_INCONCLUSIVO)

    expect(verdict.parseable).toBe(false)
    expect(verdict.status).toBe('INCONCLUSIVO')
    expect(verdict.findings).toHaveLength(0)
  })

  it('aceita veredito em qualquer caixa', () => {
    expect(parsePostDeployVerdict('veredito: consistente').status).toBe('CONSISTENTE')
    expect(parsePostDeployVerdict('Veredito: Incongruente').status).toBe('INCONGRUENTE')
    expect(parsePostDeployVerdict('VEREDITO: INCONCLUSIVO').status).toBe('INCONCLUSIVO')
  })

  it('aceita resposta envolta em cerca de código', () => {
    const verdict = parsePostDeployVerdict(`
\`\`\`
VEREDITO: CONSISTENTE
Tudo certo.
\`\`\`
`)

    expect(verdict.status).toBe('CONSISTENTE')
    expect(verdict.parseable).toBe(true)
  })

  it('extrai severidade high/medium/low corretamente', () => {
    const response = `
VEREDITO: INCONGRUENTE

## Findings

### Tarefa: task-1
- Descrição: Problema 1
- Evidência: Evidência 1
- Severidade: high

### Tarefa: task-2
- Descrição: Problema 2
- Evidência: Evidência 2
- Severidade: low

### Tarefa: task-3
- Descrição: Problema 3
- Evidência: Evidência 3
- Severidade: medium
`
    const verdict = parsePostDeployVerdict(response)

    expect(verdict.findings[0]?.severity).toBe('high')
    expect(verdict.findings[1]?.severity).toBe('low')
    expect(verdict.findings[2]?.severity).toBe('medium')
  })

  it('severidade ausente ou inválida vira medium (default)', () => {
    const response = `
VEREDITO: INCONGRUENTE

## Findings

### Tarefa: task-1
- Descrição: Problema sem severidade
- Evidência: Evidência
`
    const verdict = parsePostDeployVerdict(response)

    expect(verdict.findings[0]?.severity).toBe('medium')
  })

  it('ignora findings sem descrição nem evidência', () => {
    const response = `
VEREDITO: INCONGRUENTE

## Findings

### Tarefa: task-1

### Tarefa: task-2
- Descrição: Problema real
- Evidência: Evidência real
- Severidade: high
`
    const verdict = parsePostDeployVerdict(response)

    // Apenas task-2 deve ser incluído (task-1 não tem conteúdo)
    expect(verdict.findings).toHaveLength(1)
    expect(verdict.findings[0]?.taskId).toBe('task-2')
  })

  it('tolera texto extra antes e depois do veredito', () => {
    const response = `
Análise concluída após verificar endpoints e logs.

VEREDITO: CONSISTENTE

Todos os critérios foram atendidos.

Fim da análise.
`
    const verdict = parsePostDeployVerdict(response)

    expect(verdict.status).toBe('CONSISTENTE')
    expect(verdict.parseable).toBe(true)
  })
})
