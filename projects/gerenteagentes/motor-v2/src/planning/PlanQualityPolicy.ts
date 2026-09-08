import type { PlanCoverage, PlannedSubtask } from "./PlanPersistence.js"

export type PlanQualityResult = { ok: true } | { ok: false; reason: string }

const GENERIC_TEXT = /^(implementar alteração|alterar o componente necessário|comportamento validado|fazer a mudança)$/i

/** Gate semântico do plano: impede que um JSON estruturalmente válido seja um plano vazio. */
export function validatePlanQuality(subtasks: readonly PlannedSubtask[], coverage: PlanCoverage, description?: string): PlanQualityResult {
  if (subtasks.length === 0 || subtasks.length > 10) return { ok: false, reason: "O plano deve conter entre 1 e 10 subtarefas." }
  const explicitStages = [...(description ?? "").matchAll(/^[ \t]*(?:#{1,6}\s*)?(\d+)[.)]\s+\S+/gm)].length
  if (explicitStages > subtasks.length && explicitStages <= 10) return { ok: false, reason: `A descrição explicita ${explicitStages} etapas, mas o plano só cobre ${subtasks.length}.` }
  const sequences = new Set<number>()
  for (const subtask of subtasks) {
    if (!Number.isInteger(subtask.seq) || subtask.seq < 1 || sequences.has(subtask.seq)) return { ok: false, reason: "As sequências das subtarefas devem ser inteiras, positivas e únicas." }
    sequences.add(subtask.seq)
    if (!subtask.titulo.trim() || !subtask.scope.trim() || subtask.scope.trim().length < 20 || subtask.scope.trim().length > 2000) return { ok: false, reason: `Subtarefa ${subtask.seq} precisa de título e escopo detalhado.` }
    if (GENERIC_TEXT.test(subtask.titulo.trim()) || subtask.acceptanceCriteria.length < 2) return { ok: false, reason: `Subtarefa ${subtask.seq} tem título genérico ou critérios insuficientes.` }
    if (subtask.deliverables.length === 0) return { ok: false, reason: `Subtarefa ${subtask.seq} precisa declarar entregáveis.` }
    if (subtask.requirementsCovered.length === 0) return { ok: false, reason: `Subtarefa ${subtask.seq} precisa declarar requisitos cobertos.` }
    if (subtask.dependsOn.some((dependency) => dependency >= subtask.seq || !subtasks.some((candidate) => candidate.seq === dependency))) return { ok: false, reason: `A subtarefa ${subtask.seq} só pode depender de etapas anteriores existentes.` }
  }
  const requirementIds = new Set(coverage.requirements.map((requirement) => requirement.id))
  if (coverage.strategy && (coverage.strategy.executionOrder.length !== subtasks.length || coverage.strategy.executionOrder.some((seq, index) => seq !== [...subtasks].sort((a, b) => a.seq - b.seq)[index]?.seq))) return { ok: false, reason: "A estratégia precisa declarar a ordem completa das subtarefas." }
  if (requirementIds.size === 0) return { ok: false, reason: "O plano precisa listar os requisitos identificados." }
  if (coverage.requirements.some((requirement) => !requirement.id.trim() || !requirement.description.trim())) return { ok: false, reason: "Todo requisito precisa de identificador e descrição." }
  if (subtasks.some((subtask) => subtask.requirementsCovered.some((id) => !requirementIds.has(id)))) return { ok: false, reason: "Uma subtarefa referencia requisito inexistente." }
  const covered = new Set(coverage.coverage.map((item) => item.requirement))
  for (const requirement of coverage.requirements) {
    if (!covered.has(requirement.id)) return { ok: false, reason: `Requisito ${requirement.id} não possui cobertura.` }
    const item = coverage.coverage.find((candidate) => candidate.requirement === requirement.id)
    if (!item?.coveredBy.length || item.coveredBy.some((seq) => !sequences.has(seq))) return { ok: false, reason: `Cobertura inválida para ${requirement.id}.` }
    if (item.coveredBy.some((seq) => !subtasks.find((subtask) => subtask.seq === seq)?.requirementsCovered.includes(requirement.id))) return { ok: false, reason: `A matriz e a subtarefa divergem para ${requirement.id}.` }
  }
  if (coverage.coverage.some((item) => !requirementIds.has(item.requirement))) return { ok: false, reason: "A cobertura referencia requisito inexistente." }
  const graph = new Map(subtasks.map((subtask) => [subtask.seq, subtask.dependsOn]))
  const visiting = new Set<number>()
  const visited = new Set<number>()
  const visit = (seq: number): boolean => {
    if (visiting.has(seq)) return false
    if (visited.has(seq)) return true
    visiting.add(seq)
    for (const dependency of graph.get(seq) ?? []) if (!visit(dependency)) return false
    visiting.delete(seq); visited.add(seq); return true
  }
  if ([...graph.keys()].some((seq) => !visit(seq))) return { ok: false, reason: "As dependências das subtarefas não podem formar ciclo." }
  return { ok: true }
}
