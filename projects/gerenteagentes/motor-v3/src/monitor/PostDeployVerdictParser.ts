/**
 * Parser do veredito do PostDeployVerifier (tarefa 971).
 *
 * A missão (`monitor.verificacao_pos_deploy`) exige resposta no formato:
 *
 *   VEREDITO: CONSISTENTE | INCONGRUENTE | INCONCLUSIVO
 *
 *   ## Findings
 *
 *   ### Tarefa: <task_id>
 *   - Descrição: <o que está errado>
 *   - Evidência: <sondagem empírica, logs, endpoints>
 *   - Severidade: high | medium | low
 *
 *   (repetir para cada tarefa com problema)
 *
 * O parser é tolerante: aceita variações de formatação, cercas de código,
 * texto extra antes/depois. Resposta sem VEREDITO é INCONCLUSIVO (reagenda
 * uma vez, depois notifica humano).
 */

export type PostDeployVerdictStatus = 'CONSISTENTE' | 'INCONGRUENTE' | 'INCONCLUSIVO'
export type PostDeployFindingSeverity = 'high' | 'medium' | 'low'

export interface PostDeployFinding {
  taskId: string
  description: string
  evidence: string
  severity: PostDeployFindingSeverity
}

export interface PostDeployVerdict {
  status: PostDeployVerdictStatus
  findings: PostDeployFinding[]
  /** Resposta bruta do worker. */
  raw: string
  /** false quando não foi possível extrair VEREDITO (resposta fora do contrato). */
  parseable: boolean
}

const STATUS_VALUES: PostDeployVerdictStatus[] = ['CONSISTENTE', 'INCONGRUENTE', 'INCONCLUSIVO']
const SEVERITY_VALUES: PostDeployFindingSeverity[] = ['high', 'medium', 'low']

export function parsePostDeployVerdict(response: string): PostDeployVerdict {
  const raw = response ?? ''
  const text = stripCodeFences(raw)
  const status = matchStatus(text)
  const findings = extractFindings(text)

  if (status == null) {
    return {
      status: 'INCONCLUSIVO',
      findings: [],
      raw,
      parseable: false,
    }
  }

  return { status, findings, raw, parseable: true }
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/)
  return fenced?.[1] ?? trimmed
}

function matchStatus(text: string): PostDeployVerdictStatus | null {
  const pattern = /^\s*VEREDITO\s*:\s*(.+)$/im
  const match = text.match(pattern)
  if (!match) return null
  const candidate = (match[1] ?? '').trim().toUpperCase()
  // Ordena do mais específico para o menos específico
  const ordered = [...STATUS_VALUES].sort((a, b) => b.length - a.length)
  return ordered.find(value => candidate.includes(value)) ?? null
}

function extractFindings(text: string): PostDeployFinding[] {
  const findings: PostDeployFinding[] = []

  // Divide por seções de tarefa
  const taskSections = text.split(/^###\s*Tarefa\s*:\s*/im).slice(1) // Remove o texto antes do primeiro "### Tarefa:"

  for (const section of taskSections) {
    const lines = section.split('\n')
    const taskId = (lines[0] ?? '').trim()
    if (!taskId) continue

    let description = ''
    let evidence = ''
    let severity: PostDeployFindingSeverity = 'medium'

    // Extrai campos
    const descMatch = section.match(/-\s*Descrição\s*:\s*(.+?)(?=\n-|$)/is)
    if (descMatch) description = descMatch[1]?.trim() ?? ''

    const evidenceMatch = section.match(/-\s*Evidência\s*:\s*(.+?)(?=\n-|$)/is)
    if (evidenceMatch) evidence = evidenceMatch[1]?.trim() ?? ''

    const severityMatch = section.match(/-\s*Severidade\s*:\s*(.+?)(?=\n|$)/i)
    if (severityMatch) {
      const severityCandidate = (severityMatch[1] ?? '').trim().toLowerCase()
      severity = SEVERITY_VALUES.find(s => severityCandidate.includes(s)) ?? 'medium'
    }

    if (description || evidence) {
      findings.push({ taskId, description, evidence, severity })
    }
  }

  return findings
}
