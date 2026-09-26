export interface PromotionRetryCandidate {
  taskId: string
  taskDatabaseId?: number
  blockId: number
  projectSlug: string | null
  repoPath: string
  baseBranch: string
  taskBranch: string
  attempt: number
}

export type PromotionRetryResult =
  | { kind: "promoted" }
  | { kind: "conflict"; files: string[] }
  | { kind: "still_dirty"; reason: string }
  | { kind: "failed"; reason: string }

export interface PromotionRetryPort {
  retry(candidate: PromotionRetryCandidate): Promise<PromotionRetryResult>
}
