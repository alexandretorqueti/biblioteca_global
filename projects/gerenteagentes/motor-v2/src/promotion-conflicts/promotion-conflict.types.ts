export type PromotionConflictKind = "migration_journal" | "semantic" | "mechanical" | "unknown"

export interface PromotionConflictCandidate {
  taskId: string
  taskDatabaseId?: number
  blockId?: number
  agentId: string
  /** Projeto usado para escolher a configuração persistida do Monitor. */
  projectSlug?: string | null
  repoPath: string
  baseBranch: string
  taskBranch: string
  buildCommand?: string | null
  testCommand?: string | null
  reportedFiles?: readonly string[]
}

export interface PromotionConflictFileEvidence {
  path: string
  kind: PromotionConflictKind
  baseExcerpt: string
  taskExcerpt: string
  ancestorExcerpt: string
}

export interface PromotionConflictEvidence {
  taskId: string
  baseBranch: string
  taskBranch: string
  baseCommit: string
  taskCommit: string
  mergeBase: string
  conflictFiles: PromotionConflictFileEvidence[]
  fingerprint: string
}

export interface PromotionConflictAnalysisResult {
  recommendation: "human_review" | "create_resolution_subtask" | "resolved_automatically"
  confidence: "low" | "medium" | "high"
  report: string
}

/** Resultado da tentativa do Monitor. A promoção só é permitida após gates verdes. */
export type PromotionConflictResolutionResult =
  | { kind: "resolved"; resolutionBranch: string; resolutionCommit: string; report: string }
  | { kind: "needs_human_review"; report: string }
  | { kind: "failed"; reason: string }

/** Porta isolada para permitir simular o Monitor nos testes sem Git/Console. */
export interface PromotionConflictResolverPort {
  resolve(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence): Promise<PromotionConflictResolutionResult>
}

/** A promoção permanece fora do resolvedor para manter Git/estado da tarefa desacoplados. */
export interface PromotionConflictPromoterPort {
  promote(candidate: PromotionConflictCandidate, resolutionBranch: string): Promise<void>
}

export interface PromotionConflictAnalyzerPort {
  analyze(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence): Promise<PromotionConflictAnalysisResult>
}
