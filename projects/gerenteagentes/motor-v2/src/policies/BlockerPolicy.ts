import { failureFingerprint } from './SystemFailurePolicy.js'

export type BlockerKind = 'blocked_environment' | 'systemic_failure' | 'model_chain_exhausted' | 'correction_failed'

/** Categoria operacional que permite encaminhar um bloqueio sistêmico. */
export type SystemicFailureCategory = 'repo_dirty' | 'git_preflight' | 'missing_evidence' | 'model_chain' | 'motor_internal'

export interface BlockerEvidence {
  kind: BlockerKind
  category?: SystemicFailureCategory
  fingerprint: string
  excerpt: string
}

const SYSTEMIC_FAILURE_GUIDANCE: Record<SystemicFailureCategory, string> = {
  repo_dirty: 'limpar o repositório de execução antes de tentar novamente',
  git_preflight: 'corrigir a validação do Git/worktree e repetir a pré-verificação',
  missing_evidence: 'coletar a evidência obrigatória e reprocessar a subtarefa',
  model_chain: 'revisar a cadeia de modelos e a disponibilidade do provedor',
  motor_internal: 'inspecionar os logs do motor e abrir diagnóstico técnico',
}

/**
 * Converte mensagens legadas de systemic_failure em uma orientação acionável.
 * O kind continua sendo systemic_failure para não quebrar consultas e políticas
 * existentes; a categoria fica registrada apenas na evidência apresentada.
 */
export function classifySystemicFailure(reason: string): SystemicFailureCategory {
  const normalized = reason.toLocaleLowerCase('pt-BR')
  if (normalized.includes('repositório principal não está limpo') || normalized.includes('repo dirty')) return 'repo_dirty'
  if (normalized.includes('preflight git') || normalized.includes('pré-verificação do git')) return 'git_preflight'
  if (normalized.includes('sem evidência') || normalized.includes('sem evidencia')) return 'missing_evidence'
  if (
    normalized.includes('cadeia de modelos') ||
    normalized.includes('model chain') ||
    normalized.includes('repetida entre modelos')
  ) return 'model_chain'
  return 'motor_internal'
}

export function blockerEvidence(kind: BlockerKind, reason: string): BlockerEvidence {
  const fingerprint = failureFingerprint(reason)
  if (kind !== 'systemic_failure') return { kind, fingerprint, excerpt: reason.trim().slice(0, 500) }

  const category = classifySystemicFailure(reason)
  const excerpt = `[${category}] ${SYSTEMIC_FAILURE_GUIDANCE[category]} — ${reason.trim()}`.slice(0, 500)
  return { kind, category, fingerprint, excerpt }
}
