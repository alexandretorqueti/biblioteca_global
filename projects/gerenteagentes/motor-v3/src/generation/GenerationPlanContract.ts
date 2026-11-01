import { sanitizeModelResponse } from '../analysis/AnalystReply.js'

/**
 * Contrato de saída da Geração Macro (§5 de
 * docs/PROPOSTA-GERACAO-MACRO-TAREFAS.md): forma "plano" (plano de tarefas
 * macro revisável) ou forma "perguntas" (clarificação antes de planejar).
 *
 * O parser é o verificador canônico do motor-v3 para a resposta do analista
 * de planejamento; o schema publicado no catálogo
 * (src/prompts/output-contract-catalog.ts, chave `geracao.plano_ou_perguntas`)
 * é a referência contratual. Decisões de tolerância (documentadas):
 * - lacunas/lacunasBiblioteca/riscos/foraDeFase ausentes → normalizados para [];
 * - perguntas > 8 → truncadas para 8 (o limite do contrato é de apresentação);
 * - o objeto persistido em geracoes_projeto.tasks é o plano NORMALIZADO
 *   (apenas campos do contrato), não o JSON bruto do modelo.
 *
 * Erros de contrato são lançados como `contract_violation: ...` — a mensagem
 * é reutilizada como feedback corretivo na retentativa limitada do worker.
 */

export interface MacroRequisito {
  id: string
  texto: string
  origem: string
  classificacao: 'crud' | 'custom' | 'lacuna'
}

export interface MacroEntidade {
  nome: string
  campos: string[]
  mascarasValidacoes: string[]
  menu?: string
}

export interface MacroTarefa {
  seq: number
  titulo: string
  objetivo: string
  escopo: string
  aceite: string[]
  requisitos: string[]
  executor: 'biblioteca-global' | 'agente-projeto'
  depende_de: number[]
  auto_start: boolean
  risco: 'baixo' | 'medio' | 'alto'
}

export interface MacroCobertura {
  req: string
  cobertoPor: string
  justificativa?: string
}

export interface MacroLacunaBiblioteca {
  funcionalidade: string
  req?: string
  contexto?: string
}

export interface MacroPlano {
  kind: 'plano'
  classificacaoSistema: '100% crud' | 'misto' | 'predominantemente custom'
  requerAgenteDedicado: boolean
  requisitos: MacroRequisito[]
  especificacaoCrud: { entidades: MacroEntidade[]; observacoes?: string }
  tarefas: MacroTarefa[]
  matrizCobertura: MacroCobertura[]
  lacunas: string[]
  lacunasBiblioteca: MacroLacunaBiblioteca[]
  riscos: string[]
  foraDeFase: Array<{ req: string; motivo: string }>
}

export type GenerationOutcome =
  | { kind: 'plano'; plano: MacroPlano }
  | { kind: 'perguntas'; resumo: string; perguntas: string[] }

const CLASSIFICACOES_SISTEMA = ['100% crud', 'misto', 'predominantemente custom'] as const
const CLASSIFICACOES_REQ = ['crud', 'custom', 'lacuna'] as const
const EXECUTORES = ['biblioteca-global', 'agente-projeto'] as const
const RISCOS = ['baixo', 'medio', 'alto'] as const
const REQ_ID_PATTERN = /^REQ-[A-Z0-9_-]+$/
const MAX_PERGUNTAS = 8

function violation(message: string): never {
  throw new Error(`contract_violation: ${message}`)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) violation(`${field} deve ser um array de strings`)
  return value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(item => item.length > 0)
}

/**
 * Extrai o JSON do contrato da resposta do modelo. Aceita JSON cercado por
 * texto/blocos fenced; quando há múltiplos objetos, prefere o ÚLTIMO com a
 * assinatura do contrato (kind plano/perguntas), mesmo critério do parser da
 * análise (AnalystReply.parseAnalystReply).
 */
export function parseGenerationReply(content: string): GenerationOutcome {
  const source = sanitizeModelResponse(content)
  const candidates = extractJsonObjects(source)
  if (candidates.length === 0) {
    violation(`resposta não contém JSON (recebidos ${source.trim().length} caracteres)`)
  }
  let parsed: Record<string, any> | undefined
  let lastParseError: unknown
  for (const jsonText of [...candidates].reverse()) {
    try {
      const candidate = JSON.parse(jsonText) as unknown
      if (isRecord(candidate) && isGenerationReply(candidate)) {
        parsed = candidate
        break
      }
    } catch (error) {
      lastParseError = error
    }
  }
  if (!parsed) {
    violation(`nenhum objeto JSON com a assinatura do contrato (kind="plano"|"perguntas"): ${lastParseError instanceof Error ? lastParseError.message : 'JSON inválido'}`)
  }
  if (parsed.kind === 'perguntas' || (!parsed.kind && Array.isArray(parsed.perguntas))) {
    return parsePerguntas(parsed)
  }
  return parsePlano(parsed)
}

function isGenerationReply(candidate: Record<string, any>): boolean {
  return candidate.kind === 'plano' || candidate.kind === 'perguntas'
    || Array.isArray(candidate.tarefas) || Array.isArray(candidate.perguntas)
}

function parsePerguntas(parsed: Record<string, any>): GenerationOutcome {
  const resumo = nonEmptyString(parsed.resumo)
  if (!resumo) violation('forma "perguntas" exige resumo não vazio')
  if (!Array.isArray(parsed.perguntas)) violation('forma "perguntas" exige perguntas[]')
  const perguntas = parsed.perguntas
    .map((item: unknown) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item: string) => item.length > 0)
    .slice(0, MAX_PERGUNTAS)
  if (perguntas.length === 0) violation('forma "perguntas" com lista de perguntas vazia')
  return { kind: 'perguntas', resumo, perguntas }
}

function parsePlano(parsed: Record<string, any>): GenerationOutcome {
  if (parsed.kind !== 'plano') violation('objeto JSON não é um plano (kind="plano") nem perguntas (kind="perguntas")')

  const classificacaoSistema = CLASSIFICACOES_SISTEMA.find(value => value === parsed.classificacaoSistema)
  if (!classificacaoSistema) violation(`classificacaoSistema deve ser um de: ${CLASSIFICACOES_SISTEMA.join(' | ')}`)
  if (typeof parsed.requerAgenteDedicado !== 'boolean') violation('requerAgenteDedicado deve ser booleano')

  if (!Array.isArray(parsed.requisitos) || parsed.requisitos.length === 0) violation('requisitos[] é obrigatório (mínimo 1)')
  const requisitos: MacroRequisito[] = parsed.requisitos.map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`requisito ${index + 1} inválido`)
    const id = nonEmptyString(item.id)
    if (!id || !REQ_ID_PATTERN.test(id)) violation(`requisito ${index + 1}: id deve seguir o padrão REQ-* (ex.: REQ-F-001)`)
    const texto = nonEmptyString(item.texto)
    if (!texto) violation(`requisito ${id}: texto é obrigatório`)
    const origem = nonEmptyString(item.origem) ?? ''
    const classificacao = CLASSIFICACOES_REQ.find(value => value === item.classificacao)
    if (!classificacao) violation(`requisito ${id}: classificacao deve ser crud|custom|lacuna`)
    return { id, texto, origem, classificacao }
  })

  if (!isRecord(parsed.especificacaoCrud)) violation('especificacaoCrud é obrigatória (objeto)')
  if (!Array.isArray(parsed.especificacaoCrud.entidades)) violation('especificacaoCrud.entidades[] é obrigatória')
  const entidades: MacroEntidade[] = parsed.especificacaoCrud.entidades.map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`entidade ${index + 1} inválida`)
    const nome = nonEmptyString(item.nome)
    if (!nome) violation(`entidade ${index + 1}: nome é obrigatório`)
    const campos = stringArray(item.campos, `entidade ${nome}: campos`)
    if (campos.length === 0) violation(`entidade ${nome}: campos[] não pode ser vazio`)
    return {
      nome,
      campos,
      mascarasValidacoes: stringArray(item.mascarasValidacoes, `entidade ${nome}: mascarasValidacoes`),
      ...(nonEmptyString(item.menu) ? { menu: nonEmptyString(item.menu)! } : {}),
    }
  })
  const especificacaoCrud = {
    entidades,
    ...(nonEmptyString(parsed.especificacaoCrud.observacoes) ? { observacoes: nonEmptyString(parsed.especificacaoCrud.observacoes)! } : {}),
  }

  if (!Array.isArray(parsed.tarefas) || parsed.tarefas.length === 0) violation('tarefas[] é obrigatório (mínimo 1)')
  const tarefas: MacroTarefa[] = parsed.tarefas.map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`tarefa ${index + 1} inválida`)
    const seq = Number(item.seq)
    if (!Number.isInteger(seq) || seq < 1) violation(`tarefa ${index + 1}: seq deve ser inteiro >= 1`)
    const titulo = nonEmptyString(item.titulo)
    if (!titulo) violation(`tarefa ${seq}: titulo é obrigatório`)
    const objetivo = nonEmptyString(item.objetivo)
    if (!objetivo) violation(`tarefa ${seq}: objetivo é obrigatório`)
    const escopo = nonEmptyString(item.escopo)
    if (!escopo) violation(`tarefa ${seq}: escopo é obrigatório`)
    const aceite = stringArray(item.aceite, `tarefa ${seq}: aceite`)
    if (aceite.length === 0) violation(`tarefa ${seq}: aceite[] não pode ser vazio`)
    const requisitosTarefa = stringArray(item.requisitos, `tarefa ${seq}: requisitos`)
    if (requisitosTarefa.length === 0) violation(`tarefa ${seq}: requisitos[] (REQ-* cobertos) não pode ser vazio`)
    const executor = EXECUTORES.find(value => value === item.executor)
    if (!executor) violation(`tarefa ${seq}: executor deve ser biblioteca-global|agente-projeto`)
    if (!Array.isArray(item.depende_de)) violation(`tarefa ${seq}: depende_de[] é obrigatório (pode ser vazio)`)
    const dependeDe = item.depende_de.map((dep: unknown) => Number(dep))
    if (dependeDe.some((dep: number) => !Number.isInteger(dep) || dep < 1)) violation(`tarefa ${seq}: depende_de deve conter inteiros >= 1`)
    if (typeof item.auto_start !== 'boolean') violation(`tarefa ${seq}: auto_start deve ser booleano`)
    const risco = RISCOS.find(value => value === item.risco)
    if (!risco) violation(`tarefa ${seq}: risco deve ser baixo|medio|alto`)
    return { seq, titulo, objetivo, escopo, aceite, requisitos: requisitosTarefa, executor, depende_de: dependeDe, auto_start: item.auto_start, risco }
  })

  // Regras cruzadas do contrato (§5):
  const seqs = new Set(tarefas.map(tarefa => tarefa.seq))
  if (seqs.size !== tarefas.length) violation('tarefas com seq duplicado')
  for (const tarefa of tarefas) {
    for (const dep of tarefa.depende_de) {
      if (!seqs.has(dep)) violation(`tarefa ${tarefa.seq}: depende_de referencia seq inexistente (${dep})`)
      // Ordem topológica linear: dependências somente para tarefas anteriores.
      if (dep >= tarefa.seq) violation(`tarefa ${tarefa.seq}: depende_de=${dep} quebra a ordem topológica linear (apenas seq anteriores)`)
    }
  }
  if (!parsed.requerAgenteDedicado && tarefas.some(tarefa => tarefa.executor === 'agente-projeto')) {
    violation('requerAgenteDedicado=false, mas existem tarefas com executor "agente-projeto"')
  }

  if (!Array.isArray(parsed.matrizCobertura) || parsed.matrizCobertura.length === 0) violation('matrizCobertura[] é obrigatória (mínimo 1)')
  const matrizCobertura: MacroCobertura[] = parsed.matrizCobertura.map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`entrada ${index + 1} da matrizCobertura inválida`)
    const req = nonEmptyString(item.req)
    if (!req) violation(`matrizCobertura ${index + 1}: req é obrigatório`)
    const cobertoPor = nonEmptyString(item.cobertoPor)
    if (!cobertoPor) violation(`matrizCobertura ${req}: cobertoPor é obrigatório (tarefa:<seq>|crud:<entidade>|fora_de_fase)`)
    return { req, cobertoPor, ...(nonEmptyString(item.justificativa) ? { justificativa: nonEmptyString(item.justificativa)! } : {}) }
  })
  const requisitoIds = new Set(requisitos.map(item => item.id))
  for (const entrada of matrizCobertura) {
    if (!requisitoIds.has(entrada.req)) violation(`matrizCobertura referencia requisito inexistente: ${entrada.req}`)
    const tarefaRef = entrada.cobertoPor.match(/^tarefa:(\d+)$/)
    if (tarefaRef && !seqs.has(Number(tarefaRef[1]))) violation(`matrizCobertura ${entrada.req}: cobertoPor referencia tarefa inexistente (${entrada.cobertoPor})`)
  }
  for (const requisito of requisitos) {
    if (!matrizCobertura.some(entrada => entrada.req === requisito.id)) {
      violation(`matrizCobertura não cobre o requisito ${requisito.id} (todo requisito deve aparecer na matriz)`)
    }
  }
  for (const tarefa of tarefas) {
    for (const req of tarefa.requisitos) {
      if (!requisitoIds.has(req)) violation(`tarefa ${tarefa.seq}: referencia requisito inexistente (${req})`)
    }
  }

  const lacunasBiblioteca: MacroLacunaBiblioteca[] = (Array.isArray(parsed.lacunasBiblioteca) ? parsed.lacunasBiblioteca : []).map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`lacunasBiblioteca ${index + 1} inválida`)
    const funcionalidade = nonEmptyString(item.funcionalidade)
    if (!funcionalidade) violation(`lacunasBiblioteca ${index + 1}: funcionalidade é obrigatória`)
    return {
      funcionalidade,
      ...(nonEmptyString(item.req) ? { req: nonEmptyString(item.req)! } : {}),
      ...(nonEmptyString(item.contexto) ? { contexto: nonEmptyString(item.contexto)! } : {}),
    }
  })
  const foraDeFase = (Array.isArray(parsed.foraDeFase) ? parsed.foraDeFase : []).map((item: unknown, index: number) => {
    if (!isRecord(item)) violation(`foraDeFase ${index + 1} inválido`)
    const req = nonEmptyString(item.req)
    const motivo = nonEmptyString(item.motivo)
    if (!req || !motivo) violation(`foraDeFase ${index + 1}: req e motivo são obrigatórios`)
    return { req, motivo }
  })

  return {
    kind: 'plano',
    plano: {
      kind: 'plano',
      classificacaoSistema,
      requerAgenteDedicado: parsed.requerAgenteDedicado,
      requisitos,
      especificacaoCrud,
      tarefas,
      matrizCobertura,
      lacunas: stringArray(parsed.lacunas, 'lacunas'),
      lacunasBiblioteca,
      riscos: stringArray(parsed.riscos, 'riscos'),
      foraDeFase,
    },
  }
}

/** Extrai todos os objetos JSON balanceados; o chamador escolhe a assinatura válida. */
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
      }
    }
  }
  return objects
}
