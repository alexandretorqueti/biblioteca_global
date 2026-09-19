export interface PlannedSubtask {
  seq: number
  titulo: string
  scope: string
  acceptanceCriteria: string[]
  deliverables: string[]
  requirementsCovered: string[]
  dependsOn: number[]
}

export interface PlanCoverage {
  requirements: Array<{ id: string; description: string }>
  coverage: Array<{ requirement: string; coveredBy: number[] }>
}

export type AnalysisOutcome =
  | { kind: 'plan'; subtasks: PlannedSubtask[]; coverage: PlanCoverage }
  | { kind: 'questions'; summary: string; questions: string[] }

export function parseAnalystReply(content: string): AnalysisOutcome {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Resposta do analista não contém JSON')
  const parsed: unknown = JSON.parse(match[0])
  if (!isRecord(parsed)) throw new Error('Resposta do analista não é um objeto JSON')

  if (parsed.kind === 'perguntas' || Array.isArray(parsed.perguntas)) {
    const questions = Array.isArray(parsed.perguntas) ? parsed.perguntas.map(String).map(value => value.trim()).filter(Boolean) : []
    if (questions.length === 0) throw new Error('Analista pediu clarificação sem perguntas válidas')
    return { kind: 'questions', summary: typeof parsed.resumo === 'string' ? parsed.resumo.trim() : '', questions }
  }

  if (!Array.isArray(parsed.subtarefas) || parsed.subtarefas.length === 0) throw new Error('Analista não retornou subtarefas')
  const subtasks = parsed.subtarefas.map((value, index) => {
    if (!isRecord(value)) throw new Error(`Subtarefa ${index + 1} inválida`)
    const titulo = typeof value.titulo === 'string' ? value.titulo.trim() : ''
    const scope = typeof value.scope === 'string' ? value.scope.trim() : ''
    const acceptanceCriteria = strings(value.acceptance_criteria)
    const deliverables = strings(value.deliverables)
    const requirementsCovered = strings(value.requirements_covered)
    if (!titulo || !scope || acceptanceCriteria.length === 0 || deliverables.length === 0) {
      throw new Error(`Subtarefa ${index + 1} incompleta`)
    }
    return {
      seq: integer(value.seq, index + 1), titulo, scope, acceptanceCriteria,
      deliverables, requirementsCovered, dependsOn: integers(value.depends_on),
    }
  })

  if (!Array.isArray(parsed.requirements) || !Array.isArray(parsed.coverage)) {
    throw new Error('Plano sem requirements ou coverage')
  }
  const requirements = parsed.requirements.map(value => {
    if (!isRecord(value)) throw new Error('Requisito inválido')
    return { id: String(value.id ?? '').trim(), description: String(value.description ?? '').trim() }
  })
  const coverage = parsed.coverage.map(value => {
    if (!isRecord(value)) throw new Error('Cobertura inválida')
    return { requirement: String(value.requirement ?? '').trim(), coveredBy: integers(value.covered_by) }
  })
  if (requirements.some(item => !item.id || !item.description) || coverage.some(item => !item.requirement || item.coveredBy.length === 0)) {
    throw new Error('Matriz de cobertura incompleta')
  }
  return { kind: 'plan', subtasks, coverage: { requirements, coverage } }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean) : []
}

function integers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : []
}

function integer(value: unknown, fallback: number): number {
  const result = Number(value ?? fallback)
  if (!Number.isInteger(result) || result < 1) throw new Error('Sequência de subtarefa inválida')
  return result
}
