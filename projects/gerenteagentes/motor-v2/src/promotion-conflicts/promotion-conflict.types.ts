export type PromotionConflictKind = "migration_journal" | "semantic" | "mechanical" | "unknown"

export interface PromotionConflictCandidate {
  taskId: string
  taskDatabaseId?: number
  blockId?: number
  agentId: string
  repoPath: string
  baseBranch: string
  taskBranch: string
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
  recommendation: "human_review" | "create_resolution_subtask"
  confidence: "low" | "medium" | "high"
  report: string
}

export interface PromotionConflictAnalyzerPort {
  analyze(candidate: PromotionConflictCandidate, evidence: PromotionConflictEvidence): Promise<PromotionConflictAnalysisResult>
}

