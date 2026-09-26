export interface PlannedSubtask {
  seq: number
  titulo: string
  scope: string
  acceptanceCriteria: string[]
  deliverables: string[]
  requirementsCovered: string[]
  dependsOn: number[]
  completionKind?: 'code_change' | 'analysis' | 'external_operation' | 'no_code_change'
}

export interface PlanCoverage {
  requirements: Array<{ id: string; description: string }>
  coverage: Array<{ requirement: string; coveredBy: number[] }>
}

export type AnalysisOutcome =
  | { kind: 'plan'; subtasks: PlannedSubtask[]; coverage: PlanCoverage }
  | { kind: 'questions'; summary: string; questions: string[] }

export function parseAnalystReply(content: string, contractSchema?: unknown): AnalysisOutcome {
  const candidates = extractJsonObjects(content)
  if (candidates.length === 0) throw new Error('Resposta do analista não contém JSON')
  let parsed: unknown
  let lastParseError: unknown
  // A resposta pode mencionar objetos/código antes do contrato final. Prefira
  // o último objeto válido com a assinatura de análise esperada.
  for (const jsonText of [...candidates].reverse()) {
    try {
      const candidate = JSON.parse(jsonText) as unknown
      if (isRecord(candidate) && isAnalysisReply(candidate)) {
        parsed = candidate
        break
      }
    } catch (error) {
      lastParseError = error
    }
  }
  if (parsed === undefined) {
    throw new Error(`JSON do analista inválido: ${lastParseError instanceof Error ? lastParseError.message : 'nenhum objeto possui a assinatura esperada'}`)
  }
  if (!isRecord(parsed)) throw new Error('Resposta do analista não é um objeto JSON')
  if (contractSchema) validateJsonSchema(parsed, contractSchema)

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
      ...(typeof value.completion_kind === 'string' && ['code_change', 'analysis', 'external_operation', 'no_code_change'].includes(value.completion_kind)
        ? { completionKind: value.completion_kind as PlannedSubtask['completionKind'] } : {}),
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
    return {
      // Contratos publicados antes do v3 usavam estes aliases. A
      // normalização mantém a migração compatível sem substituir o contrato.
      requirement: String(value.requirement ?? value.requirement_id ?? '').trim(),
      coveredBy: integers(value.covered_by ?? value.subtasks),
    }
  })
  if (requirements.some(item => !item.id || !item.description) || coverage.some(item => !item.requirement || item.coveredBy.length === 0)) {
    throw new Error('Matriz de cobertura incompleta')
  }
  const requirementIds = new Set(requirements.map(item => item.id))
  const sequences = new Set(subtasks.map(item => item.seq))
  if (sequences.size !== subtasks.length) throw new Error('Sequências de subtarefas duplicadas')
  if (coverage.some(item => !requirementIds.has(item.requirement) || item.coveredBy.some(seq => !sequences.has(seq)))) {
    throw new Error('Matriz de cobertura referencia requisito ou subtarefa inexistente')
  }
  if (requirements.some(requirement => !coverage.some(item => item.requirement === requirement.id))) {
    throw new Error('Matriz de cobertura não cobre todos os requisitos')
  }
  return { kind: 'plan', subtasks, coverage: { requirements, coverage } }
}

/** Extrai todos os objetos balanceados; o chamador escolhe a assinatura válida. */
function extractJsonObjects(content: string): string[] {
  const source = content.trim()
  const objects: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (start < 0) {
      if (character !== '{') continue
      start = index
      depth = 1
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        objects.push(source.slice(start, index + 1))
        start = -1
        inString = false
        escaped = false
      }
    }
  }
  return objects
}

function isAnalysisReply(value: Record<string, any>): boolean {
  return value.kind === 'perguntas' || Array.isArray(value.perguntas) || Array.isArray(value.subtarefas)
}

/** Validador do subconjunto de JSON Schema usado pelos contratos publicados. */
function validateJsonSchema(value: unknown, schema: unknown, path = '$'): void {
  if (!isRecord(schema)) return
  if (Array.isArray(schema.oneOf)) {
    const errors: string[] = []
    for (const option of schema.oneOf) {
      try { validateJsonSchema(value, option, path); return } catch (error) { errors.push(String((error as Error).message)) }
    }
    throw new Error(`Resposta não atende a nenhuma assinatura do contrato: ${errors.join(' | ')}`)
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) throw new Error(`${path} deve ser objeto`)
    for (const field of Array.isArray(schema.required) ? schema.required.map(String) : []) {
      if (!(field in value)) throw new Error(`${path}.${field} é obrigatório`)
    }
    if (isRecord(schema.properties)) {
      for (const [field, childSchema] of Object.entries(schema.properties)) {
        if (field in value) validateJsonSchema(value[field], childSchema, `${path}.${field}`)
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} deve ser array`)
    if (Number(schema.minItems ?? 0) > value.length) throw new Error(`${path} deve ter ao menos ${schema.minItems} item(ns)`)
    if (schema.items) value.forEach((item, index) => validateJsonSchema(item, schema.items, `${path}[${index}]`))
  } else if (schema.type === 'string' && typeof value !== 'string') {
    throw new Error(`${path} deve ser string`)
  } else if (schema.type === 'integer' && !Number.isInteger(value)) {
    throw new Error(`${path} deve ser inteiro`)
  }
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
