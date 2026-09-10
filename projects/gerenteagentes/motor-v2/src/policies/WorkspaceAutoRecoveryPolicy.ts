import { createHash } from "node:crypto"

export interface WorkspaceRecoveryDecision {
  recoverable: boolean
  code?: "git_workspace_invalid"
  fingerprint?: string
  reason?: string
}

const RECOVERABLE_GIT_WORKSPACE_PATTERNS = [
  /fatal:\s*not a git repository(?::|\s|$)/i,
  /not a git repository:\s*\(null\)/i,
  /cannot change to ['"]?[^\n]*worktrees[^\n]*['"]?:\s*no such file or directory/i,
  /failed to resolve git dir/i,
]

/**
 * Decide se uma falha ocorreu antes da entrega e pode ser corrigida recriando
 * somente o worktree da tentativa. A lista é deliberadamente restrita:
 * conflitos, repositório sujo, gates vermelhos e configuração inválida nunca
 * entram em recuperação automática.
 */
export function identifyWorkspaceAutoRecovery(input: {
  error: string
  phase: "analyze" | "execute"
  subtaskId?: number
  workspaceCommitSha?: string | null
}): WorkspaceRecoveryDecision {
  if (input.phase !== "execute" || !input.subtaskId || input.workspaceCommitSha) {
    return { recoverable: false }
  }

  const normalized = input.error.trim().replace(/\s+/g, " ")
  if (!RECOVERABLE_GIT_WORKSPACE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { recoverable: false }
  }

  const code = "git_workspace_invalid" as const
  return {
    recoverable: true,
    code,
    fingerprint: createHash("sha256").update(`${code}:${input.subtaskId}`).digest("hex").slice(0, 24),
    reason: `Workspace Git inválido antes da entrega: ${normalized}`.slice(0, 500),
  }
}
