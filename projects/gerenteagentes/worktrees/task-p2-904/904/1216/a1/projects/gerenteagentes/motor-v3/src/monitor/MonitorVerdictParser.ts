/**
 * Parser do veredito do Monitor-Resolvedor.
 *
 * A missão (`monitor.resolucao_bloqueio`) exige resposta no formato:
 *
 *   STATUS: RESOLVIDO | PARCIALMENTE_RESOLVIDO | NAO_RESOLVIDO
 *   ORIGEM: DEV | TESTES_DEV | MOTOR | EXTERNO
 *   CAUSA: ... CORREÇÃO: ... VALIDAÇÃO: ... DEPLOY: ... RETOMADA: ...
 *   MENSAGEM_CHAT: ...
 *
 * O parser é tolerante: aceita variações sem acento, headers em qualquer
 * caixa, cercas de código e texto extra antes/depois. Resposta sem STATUS
 * é `parseable=false` e tratada de forma conservadora (bloqueio permanece).
 */

export type MonitorVerdictStatus = 'RESOLVIDO' | 'PARCIALMENTE_RESOLVIDO' | 'NAO_RESOLVIDO'
export type MonitorVerdictOrigin = 'DEV' | 'TESTES_DEV' | 'MOTOR' | 'EXTERNO' | 'DESCONHECIDA'

export interface MonitorVerdict {
  status: MonitorVerdictStatus
  origin: MonitorVerdictOrigin
  cause: string
  correction: string
  validation: string
  deploy: string
  resumption: string
  /** Mensagem destinada ao chat da tarefa (MENSAGEM_CHAT ou síntese). */
  chatMessage: string
  /** Resposta bruta do worker. */
  raw: string
  /** false quando não foi possível extrair STATUS (resposta fora do contrato). */
  parseable: boolean
}

const SECTION_HEADERS = ['CAUSA', 'CORREÇÃO', 'CORRECAO', 'VALIDAÇÃO', 'VALIDACAO', 'DEPLOY', 'RETOMADA', 'MENSAGEM_CHAT'] as const

const STATUS_VALUES: MonitorVerdictStatus[] = ['RESOLVIDO', 'PARCIALMENTE_RESOLVIDO', 'NAO_RESOLVIDO']
const ORIGIN_VALUES: MonitorVerdictOrigin[] = ['DEV', 'TESTES_DEV', 'MOTOR', 'EXTERNO']

export function parseMonitorVerdict(response: string): MonitorVerdict {
  const raw = response ?? ''
  const text = stripCodeFences(raw)
  const status = matchEnum(text, 'STATUS', STATUS_VALUES)
  const origin = matchEnum(text, 'ORIGEM', ORIGIN_VALUES) ?? 'DESCONHECIDA'
  const sections = extractSections(text)
  const cause = sections.get('CAUSA') ?? ''
  const correction = sections.get('CORREÇÃO') ?? sections.get('CORRECAO') ?? ''
  const validation = sections.get('VALIDAÇÃO') ?? sections.get('VALIDACAO') ?? ''
  const deploy = sections.get('DEPLOY') ?? ''
  const resumption = sections.get('RETOMADA') ?? ''
  const explicitChat = (sections.get('MENSAGEM_CHAT') ?? '').trim()
  if (status == null) {
    return {
      status: 'NAO_RESOLVIDO', origin: 'DESCONHECIDA',
      cause, correction, validation, deploy, resumption,
      chatMessage: explicitChat || 'O Monitor executou a missão, mas a resposta não seguiu o contrato de veredito (STATUS ausente). O bloqueio permanece para revisão.',
      raw, parseable: false,
    }
  }
  const chatMessage = explicitChat || synthesizeChatMessage({ status, origin, cause, correction, validation })
  return { status, origin, cause, correction, validation, deploy, resumption, chatMessage, raw, parseable: true }
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  return fenced?.[1] ?? trimmed
}

function matchEnum<T extends string>(text: string, header: string, values: T[]): T | null {
  const pattern = new RegExp(`^\\s*${header}\\s*:\\s*(.+)$`, 'im')
  const match = text.match(pattern)
  if (!match) return null
  const candidate = (match[1] ?? '').trim().toUpperCase()
  // Ordena do mais específico para o menos específico (PARCIALMENTE_RESOLVIDO antes de RESOLVIDO,
  // NAO_RESOLVIDO antes de RESOLVIDO) para não casar prefixos.
  const ordered = [...values].sort((a, b) => b.length - a.length)
  return ordered.find(value => candidate.includes(value)) ?? null
}

function extractSections(text: string): Map<string, string> {
  const headerPattern = new RegExp(`^\\s*(${SECTION_HEADERS.join('|')})\\s*:`, 'img')
  const marks: Array<{ header: string; start: number; contentStart: number }> = []
  let match: RegExpExecArray | null
  while ((match = headerPattern.exec(text)) !== null) {
    marks.push({ header: (match[1] ?? '').toUpperCase(), start: match.index, contentStart: match.index + match[0].length })
  }
  const sections = new Map<string, string>()
  marks.forEach((mark, index) => {
    const next = marks[index + 1]
    const end = next ? next.start : text.length
    // CONTEÚDO até o próximo header; ignora linhas STATUS/ORIGEM soltas no meio
    const content = text.slice(mark.contentStart, end)
      .replace(/^\s*(STATUS|ORIGEM)\s*:.*$/gim, '')
      .trim()
    if (!sections.has(mark.header)) sections.set(mark.header, content)
  })
  return sections
}

function synthesizeChatMessage(verdict: {
  status: MonitorVerdictStatus
  origin: MonitorVerdictOrigin
  cause: string
  correction: string
  validation: string
}): string {
  const parts = [
    `O Monitor analisou o bloqueio e classificou a origem como ${verdict.origin}.`,
    verdict.cause ? `Causa: ${verdict.cause}` : null,
    verdict.correction && verdict.correction !== 'nenhuma' ? `Correção: ${verdict.correction}` : null,
    verdict.validation ? `Validação: ${verdict.validation}` : null,
    verdict.status === 'RESOLVIDO'
      ? 'Bloqueio resolvido; a tarefa segue seu curso.'
      : 'Não foi possível resolver completamente; o bloqueio permanece para revisão.',
  ]
  return parts.filter(Boolean).join('\n')
}
